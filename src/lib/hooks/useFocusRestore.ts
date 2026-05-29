import { useRef, useEffect } from 'react';

export function useFocusRestore() {
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    return () => {
      if (previousFocus.current instanceof HTMLElement) {
        previousFocus.current.focus();
      }
    };
  }, []);

  return previousFocus;
}
