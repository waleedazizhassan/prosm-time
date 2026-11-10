import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import FormGrid from "../../components/common/FormGrid";
import Input from "../../components/common/Input";
import SuccessText from "../../components/common/SuccessText";

const MAX_LOCATION_DAYS = 30;
const MAX_PHOTO_DAYS = 90;

// The Owner can shorten how long location points and attendance photos are kept
// (Privacy Policy, section 8), never lengthen them. It applies to what is stored.
export default function RetentionSettingsCard() {
  const { t } = useTranslation("settings");
  const [locationDays, setLocationDays] = useState("");
  const [photoDays, setPhotoDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void requireSupabaseClient()
      .rpc("get_prosm_time_retention")
      .then(({ data }) => {
        if (!data) return;
        setLocationDays(String(data.locationDays));
        setPhotoDays(String(data.photoDays));
      });
  }, []);

  if (!locationDays) return null;

  const location = Number(locationDays);
  const photo = Number(photoDays);
  const valid = Number.isInteger(location) && Number.isInteger(photo) && location >= 1 && location <= MAX_LOCATION_DAYS && photo >= 1 && photo <= MAX_PHOTO_DAYS;

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const { error: failed } = await requireSupabaseClient().rpc("set_prosm_time_retention", { p_location_days: location, p_photo_days: photo });
    setSaving(false);
    if (failed) setError(t("retention.saveFailed"));
    else setSaved(true);
  };

  return (
    <Card title={t("retention.title")} subtitle={t("retention.subtitle")}>
      <FormGrid columns={2} gap="sm">
        <Input name="locationRetention" type="number" label={t("retention.location", { max: MAX_LOCATION_DAYS })} value={locationDays} onChange={(event) => setLocationDays(event.target.value)} />
        <Input name="photoRetention" type="number" label={t("retention.photo", { max: MAX_PHOTO_DAYS })} value={photoDays} onChange={(event) => setPhotoDays(event.target.value)} />
      </FormGrid>
      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "var(--space-3)" }}>
        <Button onClick={save} loading={saving} disabled={!valid || saving}>
          {t("retention.save")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("retention.saved")}</SuccessText> : null}
    </Card>
  );
}
