# Manual Terminal Rendering Checklist

1. Initial render correctness
- Open a workspace thread with existing output.
- Do not type anything.
- Expected: terminal paints the latest screen immediately (no stale/blank frame waiting for input).

2. Scroll stability (no meshing)
- Scroll up and down through large output.
- Expected: lines stay distinct, no overlaps, no merged glyph rows, no redraw corruption.

3. PTY demo mode (dev-only)
- Enable `Demo PTY` in the bottom bar.
- Open/reopen a thread to start the demo stream.
- Expected: delayed line streaming, wrapped long lines, cursor-rewrite output, and progress updates render cleanly.

4. Large burst resilience
- In demo mode, let burst output complete.
- Expected: UI remains responsive and terminal repaints smoothly without freeze.

5. Resize correctness
- Resize app window repeatedly while output streams.
- Expected: terminal re-fits and wraps correctly; no resize loops; no clipped canvas.

6. Diagnostic logging (dev-only)
- Enable `Term Logs` in the bottom bar.
- Open browser dev tools console.
- Expected: periodic logs include PTY event counts/sizes, queue pending/high-water stats, and resize events.
