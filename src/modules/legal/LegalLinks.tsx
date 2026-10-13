import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// "Privacy Policy · Terms of Use" - on the sign-in screens and in Help.
export default function LegalLinks({ color }: { color?: string }) {
  const { t } = useTranslation("common");
  // The sign-in screens hide their card on a background click; a link is not a background click.
  const stop = (event: MouseEvent) => event.stopPropagation();
  const style = { color: color ?? "inherit", textDecoration: "underline" };
  return (
    <span onClick={stop}>
      <Link to="/privacy" style={style}>
        {t("legal.privacy")}
      </Link>
      {" · "}
      <Link to="/terms" style={style}>
        {t("legal.terms")}
      </Link>
    </span>
  );
}
