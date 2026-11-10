import { useEffect, useState } from "react";

import PayrollCycleRepository from "../../core/repositories/PayrollCycleRepository";
import { setPayrollDigits, type DigitSystem } from "./payrollUi";

// Owner 2026-11-10: "one shape for the numbers, following the language of the country whose law
// applies". The payroll's country (insurance and tax settings) decides: the Arab countries that
// write ٠١٢٣ get Arabic-Indic digits everywhere in payroll - totals and the boxes alike - the
// others 0123. Read once per session; until it is known the browser's own way is used.
const ARABIC_INDIC = new Set(["EG", "SA", "SD", "IQ", "SY", "YE", "KW", "QA", "BH", "OM", "JO", "LB", "PS", "AE"]);

let resolved: Promise<DigitSystem | null> | null = null;

export function digitsForCountry(code: string | null | undefined): DigitSystem | null {
  if (!code) return null;
  return ARABIC_INDIC.has(code.toUpperCase()) ? "arab" : "latn";
}

export default function usePayrollDigits(): DigitSystem | null {
  const [system, setSystem] = useState<DigitSystem | null>(null);
  useEffect(() => {
    let live = true;
    resolved ??= PayrollCycleRepository.getStatutory().then((r) => digitsForCountry(r.data?.countryCode));
    void resolved.then((value) => {
      setPayrollDigits(value);
      if (live) setSystem(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return system;
}

/** Forget the country (after it is changed in the insurance and tax settings). */
export function resetPayrollDigits() {
  resolved = null;
}
