import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Clip } from "@/types";
import { SpeedSection } from "../SpeedSection";

function makeClip(over: Partial<Clip> = {}): Clip {
  return { id: "a", trackId: "t", mediaId: "m", startTime: 0, duration: 90, trimIn: 0, trimOut: 90, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0, ...over };
}

describe("SpeedSection", () => {
  it("applies a preset", () => {
    const onSpeedChange = vi.fn();
    render(<SpeedSection selectedClip={makeClip()} onSpeedChange={onSpeedChange} />);
    fireEvent.click(screen.getByRole("button", { name: "1.5x" }));
    expect(onSpeedChange).toHaveBeenCalledWith(1.5);
  });

  it("turns a wanted duration into a speed (90 s into 60 s = 1.5x)", () => {
    const onSpeedChange = vi.fn();
    render(<SpeedSection selectedClip={makeClip()} onSpeedChange={onSpeedChange} />);
    fireEvent.change(screen.getByPlaceholderText("ej. 58"), { target: { value: "60" } });
    expect(screen.getByText("Quedaria a 1.5x.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    expect(onSpeedChange).toHaveBeenCalledWith(1.5);
  });

  it("accepts a decimal comma", () => {
    const onSpeedChange = vi.fn();
    render(<SpeedSection selectedClip={makeClip({ trimOut: 90, duration: 90 })} onSpeedChange={onSpeedChange} />);
    fireEvent.change(screen.getByPlaceholderText("ej. 58"), { target: { value: "58,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    expect(onSpeedChange.mock.calls[0][0]).toBeCloseTo(90 / 58.5, 5);
  });

  it("refuses a duration that would need more than the supported range", () => {
    const onSpeedChange = vi.fn();
    render(<SpeedSection selectedClip={makeClip()} onSpeedChange={onSpeedChange} />);
    fireEvent.change(screen.getByPlaceholderText("ej. 58"), { target: { value: "5" } }); // 18x
    expect((screen.getByRole("button", { name: "Ajustar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/limite/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    expect(onSpeedChange).not.toHaveBeenCalled();
  });

  it("shows the real durations and offers a reset only when the speed is not 1", () => {
    const { rerender } = render(<SpeedSection selectedClip={makeClip()} onSpeedChange={() => {}} />);
    expect(screen.queryByText("Restablecer")).toBeNull();
    rerender(<SpeedSection selectedClip={makeClip({ speed: 1.5, duration: 60 })} onSpeedChange={() => {}} />);
    expect(screen.getByText(/Dura 60.0 s/)).toBeTruthy();
    expect(screen.getByText(/90.0 s del original/)).toBeTruthy();
    expect(screen.getByText("Restablecer")).toBeTruthy();
  });
});
