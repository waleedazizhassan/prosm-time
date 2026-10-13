import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { LEGAL_DOCUMENTS, legalLanguage } from "./legalContent";
import styles from "./LegalPage.module.css";

// Public page (no sign-in needed): the Privacy Policy or the Terms of Use
// in Arabic or English; other app languages show the English text with a note.
export default function LegalPage({ document }: { document: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation("common");
  const navigate = useNavigate();
  const language = legalLanguage(i18n.language);
  const doc = LEGAL_DOCUMENTS[document][language];
  const other = document === "privacy" ? "terms" : "privacy";

  return (
    <div className={styles.page} dir={language === "ar" ? "rtl" : "ltr"}>
      <article className={styles.doc}>
        <button type="button" className={styles.back} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
          {t("legal.back")}
        </button>
        <h1 className={styles.title}>{doc.title}</h1>
        <p className={styles.updated}>{doc.updated}</p>
        {i18n.language !== "ar" && i18n.language !== "en" ? <p className={styles.note}>{t("legal.languageNote")}</p> : null}
        {doc.intro.map((paragraph) => (
          <p key={paragraph} className={styles.paragraph}>
            {paragraph}
          </p>
        ))}
        {doc.sections.map((section) => (
          <section key={section.heading}>
            <h2 className={styles.heading}>{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph} className={styles.paragraph}>
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className={styles.list}>
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
        <p className={styles.other}>
          <Link to={`/${other}`}>{t(`legal.${other}`)}</Link>
        </p>
      </article>
    </div>
  );
}
