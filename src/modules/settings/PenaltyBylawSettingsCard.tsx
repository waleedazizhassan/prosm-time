import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import HintText from "../../components/common/HintText";

// HR suite feature 1: Settings -> the penalties bylaw (its own page: limits, violations, approval steps,
// incentives, publishing)
export default function PenaltyBylawSettingsCard() {
  const { t } = useTranslation("penalties");
  const navigate = useNavigate();
  return (
    <Card title={t("bylaw.title")} actions={<Button size="sm" onClick={() => navigate("/penalties/bylaw")}>{t("bylaw.open")}</Button>}>
      <HintText>{t("bylaw.cardHint")}</HintText>
    </Card>
  );
}
