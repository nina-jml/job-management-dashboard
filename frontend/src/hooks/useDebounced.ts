import { useEffect, useState } from "react";

/**
 * Trail a rapidly-changing value, so typing does not become one request per
 * keystroke.
 *
 * The input itself stays uncontrolled by this — the field updates immediately
 * and only the *query* waits. Debouncing the displayed value instead would make
 * the box feel broken, which is the usual way this gets implemented wrong.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    // Cleared on every change, so the timer only fires once typing pauses.
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
