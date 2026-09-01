import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Ported from PROSM Platform's own useAppHistory (§ visual consistency
// pass, Header Back/Forward). Tracks in-app navigation as its own
// stack, separate from the browser's real history entries. A naive
// Back button wired to navigate(-1) is unsafe here: if a user lands
// directly on /dashboard (bookmark, deep link, post-login redirect)
// with no prior in-app navigation, pressing Back would walk the user
// out of PROSM Time entirely. Disabling Back once the stack has
// nowhere left to go inside the app prevents that, while still using
// real navigate(-1)/navigate(1) so scroll position and route state
// behave exactly like native browser back/forward for every step that
// IS safe to take.
export default function useAppHistory() {
  const location = useLocation();
  const navigate = useNavigate();

  const stackRef = useRef([location.pathname]);
  const indexRef = useRef(0);
  const pendingIndexRef = useRef<number | null>(null);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    const stack = stackRef.current;
    const currentIndex = indexRef.current;

    if (pendingIndexRef.current !== null) {
      indexRef.current = pendingIndexRef.current;
      pendingIndexRef.current = null;
    } else if (stack[currentIndex] === location.pathname) {
      // Same path re-rendering (e.g. query/hash-only change) - no stack move.
    } else if (currentIndex > 0 && stack[currentIndex - 1] === location.pathname) {
      // Real browser Back button pressed - mirror the stack pointer.
      indexRef.current -= 1;
    } else if (currentIndex < stack.length - 1 && stack[currentIndex + 1] === location.pathname) {
      // Real browser Forward button pressed.
      indexRef.current += 1;
    } else {
      // A genuinely new in-app navigation - truncate any forward
      // entries (matches standard browser history semantics) and push.
      const nextStack = stack.slice(0, currentIndex + 1);
      nextStack.push(location.pathname);
      stackRef.current = nextStack;
      indexRef.current = nextStack.length - 1;
    }

    setCanGoBack(indexRef.current > 0);
    setCanGoForward(indexRef.current < stackRef.current.length - 1);
  }, [location.pathname]);

  const goBack = () => {
    if (indexRef.current <= 0) return;
    pendingIndexRef.current = indexRef.current - 1;
    navigate(-1);
  };

  const goForward = () => {
    if (indexRef.current >= stackRef.current.length - 1) return;
    pendingIndexRef.current = indexRef.current + 1;
    navigate(1);
  };

  return { canGoBack, canGoForward, goBack, goForward };
}
