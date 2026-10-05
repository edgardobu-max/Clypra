/**
 * WebGL2 Color Grade Processor
 *
 * Applies brightness/contrast/saturation and an optional 3D LUT (.cube) to a
 * single frame via one GPU shader pass. This is the shared color-grading
 * step used by both the live preview and the export rasterizer
 * (rasterizer.ts calls into this) so the two paths can never diverge
 * visually.
 *
 * One offscreen WebGL2 context is kept alive for the process lifetime — 3D
 * texture upload is the expensive part, so parsed LUTs are cached by id and
 * re-uploaded only once.
 */

import type { ParsedCubeLut } from "./cubeParser";

const VERT_SRC = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Flip V: texImage2D uploads the source top-row-first, but WebGL's texture
  // origin is bottom-left, so sampling with unflipped UVs renders upside down.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D u_source;
uniform sampler3D u_lut;
uniform bool u_useLut;
uniform float u_lutSize;
uniform float u_intensity;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;

uniform float u_brightness; // additive, -1..1
uniform float u_contrast;   // multiplier around 0.5 pivot, 0..2 (1 = no change)
uniform float u_saturation; // 0..2 (1 = no change, 0 = grayscale)
uniform float u_sharpness;  // 0..1 detail enhancement (0 = off)
uniform vec2 u_texel;       // one OUTPUT pixel in uv units

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 color = src.rgb;

  // Detail enhancement (unsharp mask on luma): add back the difference between a pixel and the
  // average of its four neighbours. Working on luma keeps colours from fringing, the clamp keeps
  // hard edges from growing halos. Sampled at output-pixel spacing, so upscaled footage is
  // sharpened at the resolution it is actually shown.
  if (u_sharpness > 0.0) {
    vec3 around = (texture(u_source, v_uv + vec2(u_texel.x, 0.0)).rgb +
                   texture(u_source, v_uv - vec2(u_texel.x, 0.0)).rgb +
                   texture(u_source, v_uv + vec2(0.0, u_texel.y)).rgb +
                   texture(u_source, v_uv - vec2(0.0, u_texel.y)).rgb) * 0.25;
    float detail = clamp(dot(color - around, vec3(0.2126, 0.7152, 0.0722)), -0.2, 0.2);
    color += detail * (u_sharpness * 1.8);
  }

  // Basic adjustments (matches typical NLE order: correct, then grade).
  color += u_brightness;
  color = (color - 0.5) * u_contrast + 0.5;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_saturation);
  color = clamp(color, 0.0, 1.0);

  if (u_useLut) {
    vec3 domainRange = max(u_domainMax - u_domainMin, vec3(1e-5));
    vec3 normalized = clamp((color - u_domainMin) / domainRange, 0.0, 1.0);

    // Standard texel-center-correct 3D LUT sampling.
    vec3 scale = vec3((u_lutSize - 1.0) / u_lutSize);
    vec3 offset = vec3(0.5 / u_lutSize);
    vec3 lutCoord = normalized * scale + offset;

    vec3 graded = texture(u_lut, lutCoord).rgb;
    color = mix(color, graded, u_intensity);
  }

  fragColor = vec4(color, src.a);
}
`;

interface CachedLut {
  texture: WebGLTexture;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export interface ColorGradeOptions {
  lutId?: string;
  lut?: ParsedCubeLut;
  /** LUT blend strength, 0.0-1.0. */
  lutIntensity?: number;
  /** Additive, -1.0 to 1.0. 0 = no change. */
  brightness?: number;
  /** Multiplier around the midpoint, 0.0-2.0. 1 = no change. */
  contrast?: number;
  /** 0.0-2.0. 1 = no change, 0 = grayscale. */
  saturation?: number;
  /** Detail enhancement, 0.0-1.0. 0 = off. */
  sharpness?: number;
}

class ColorGradeProcessor {
  private _canvas: OffscreenCanvas;
  private _gl: WebGL2RenderingContext;
  private _program: WebGLProgram;
  private _vao: WebGLVertexArrayObject;
  private _sourceTexture: WebGLTexture;
  private _dummyLutTexture: WebGLTexture;
  private _lutCache = new Map<string, CachedLut>();
  private _linearFloatSupported: boolean;

  private _uSource: WebGLUniformLocation | null;
  private _uLut: WebGLUniformLocation | null;
  private _uUseLut: WebGLUniformLocation | null;
  private _uLutSize: WebGLUniformLocation | null;
  private _uIntensity: WebGLUniformLocation | null;
  private _uDomainMin: WebGLUniformLocation | null;
  private _uDomainMax: WebGLUniformLocation | null;
  private _uBrightness: WebGLUniformLocation | null;
  private _uContrast: WebGLUniformLocation | null;
  private _uSaturation: WebGLUniformLocation | null;
  private _uSharpness: WebGLUniformLocation | null;
  private _uTexel: WebGLUniformLocation | null;

  constructor() {
    this._canvas = new OffscreenCanvas(1, 1);
    const gl = this._canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error("[ColorGradeProcessor] WebGL2 unavailable");
    this._gl = gl;

    // Enables gl.LINEAR filtering on 3D float textures (trilinear LUT
    // interpolation). Falls back to NEAREST (visible banding) without it —
    // supported on effectively all desktop/mobile GPUs since ~2015.
    this._linearFloatSupported = !!gl.getExtension("OES_texture_float_linear");

    this._program = this._compileProgram();
    this._uSource = gl.getUniformLocation(this._program, "u_source");
    this._uLut = gl.getUniformLocation(this._program, "u_lut");
    this._uUseLut = gl.getUniformLocation(this._program, "u_useLut");
    this._uLutSize = gl.getUniformLocation(this._program, "u_lutSize");
    this._uIntensity = gl.getUniformLocation(this._program, "u_intensity");
    this._uDomainMin = gl.getUniformLocation(this._program, "u_domainMin");
    this._uDomainMax = gl.getUniformLocation(this._program, "u_domainMax");
    this._uBrightness = gl.getUniformLocation(this._program, "u_brightness");
    this._uContrast = gl.getUniformLocation(this._program, "u_contrast");
    this._uSaturation = gl.getUniformLocation(this._program, "u_saturation");
    this._uSharpness = gl.getUniformLocation(this._program, "u_sharpness");
    this._uTexel = gl.getUniformLocation(this._program, "u_texel");

    this._vao = this._buildFullscreenQuad();

    this._sourceTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Always keep a valid (if unused) 3D texture bound to the LUT sampler so
    // the shader never samples an incomplete texture when u_useLut is false.
    this._dummyLutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this._dummyLutTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array([0, 0, 0]));
  }

  private _compileProgram(): WebGLProgram {
    const gl = this._gl;
    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`[ColorGradeProcessor] Shader error: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const vert = compile(gl.VERTEX_SHADER, VERT_SRC);
    const frag = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[ColorGradeProcessor] Link error: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return program;
  }

  private _buildFullscreenQuad(): WebGLVertexArrayObject {
    const gl = this._gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // Two triangles covering clip space [-1, 1].
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this._program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Build (or fetch from cache) the 3D texture for a given LUT id. */
  private _getOrBuildLutTexture(lutId: string, lut: ParsedCubeLut): CachedLut {
    const cached = this._lutCache.get(lutId);
    if (cached && cached.size === lut.size) return cached;

    const gl = this._gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const filter = this._linearFloatSupported ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);

    // .cube data is laid out red-fastest, matching WebGL's row-major
    // (width=r, height=g, depth=b) texImage3D expectation exactly.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);

    const entry: CachedLut = { texture, size: lut.size, domainMin: lut.domainMin, domainMax: lut.domainMax };
    this._lutCache.set(lutId, entry);
    return entry;
  }

  /** Drop a LUT from the GPU cache (e.g. when removed from the library). */
  evictLut(lutId: string): void {
    const cached = this._lutCache.get(lutId);
    if (!cached) return;
    this._gl.deleteTexture(cached.texture);
    this._lutCache.delete(lutId);
  }

  /**
   * Apply brightness/contrast/saturation and (optionally) a LUT to `source`
   * at (width, height). Returns the processor's internal canvas — the
   * caller must draw/consume it before calling apply() again, since the
   * canvas is reused across calls.
   */
  apply(source: CanvasImageSource, width: number, height: number, options: ColorGradeOptions): OffscreenCanvas {
    const gl = this._gl;

    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    const useLut = !!(options.lutId && options.lut);

    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sourceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.uniform1i(this._uSource, 0);

    gl.activeTexture(gl.TEXTURE1);
    if (useLut) {
      const lutTex = this._getOrBuildLutTexture(options.lutId!, options.lut!);
      gl.bindTexture(gl.TEXTURE_3D, lutTex.texture);
      gl.uniform1f(this._uLutSize, lutTex.size);
      gl.uniform1f(this._uIntensity, Math.max(0, Math.min(1, options.lutIntensity ?? 1.0)));
      gl.uniform3fv(this._uDomainMin, lutTex.domainMin);
      gl.uniform3fv(this._uDomainMax, lutTex.domainMax);
    } else {
      gl.bindTexture(gl.TEXTURE_3D, this._dummyLutTexture);
    }
    gl.uniform1i(this._uLut, 1);
    gl.uniform1i(this._uUseLut, useLut ? 1 : 0);

    gl.uniform1f(this._uBrightness, options.brightness ?? 0);
    gl.uniform1f(this._uContrast, options.contrast ?? 1);
    gl.uniform1f(this._uSaturation, options.saturation ?? 1);
    gl.uniform1f(this._uSharpness, Math.max(0, Math.min(1, options.sharpness ?? 0)));
    gl.uniform2f(this._uTexel, 1 / width, 1 / height);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    return this._canvas;
  }
}

let _singleton: ColorGradeProcessor | null = null;
let _unavailable = false;

/** Get the shared color-grade processor, or null if WebGL2 isn't available. */
export function getLutProcessor(): ColorGradeProcessor | null {
  if (_unavailable) return null;
  if (!_singleton) {
    try {
      _singleton = new ColorGradeProcessor();
    } catch (err) {
      console.error("[ColorGradeProcessor] Failed to initialize, color grading will be skipped:", err);
      _unavailable = true;
      return null;
    }
  }
  return _singleton;
}
