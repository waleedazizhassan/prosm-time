import { useSyncExternalStore } from "react";
import RadioPlaybackEngine, { type RadioEngineState } from "../services/RadioPlaybackEngine";

// PROSM Time - a thin useSyncExternalStore binding over
// RadioPlaybackEngine, same shape as Platform's own useRadio(). Any
// component calling this re-renders exactly when playback state
// actually changes, never on unrelated app re-renders.
export default function useRadio(): RadioEngineState {
  return useSyncExternalStore(RadioPlaybackEngine.subscribe, RadioPlaybackEngine.getSnapshot);
}
