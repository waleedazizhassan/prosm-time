import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Smartphone } from "lucide-react";

import Button from "../../components/common/Button";
import EmptyState from "../../components/common/EmptyState";
import ErrorText from "../../components/common/ErrorText";
import Modal from "../../components/common/Modal";
import useConfirm from "../../components/common/useConfirm";
import LicenseRepository, { type LicensedDevice } from "../../core/repositories/LicenseRepository";
import { deviceId } from "../../core/services/DeviceService";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import styles from "./HeaderOrganizationCard.module.css";

// Owner 2026-10-27: the devices that count against the licence - each with
// who used it and when it was last seen - and a button to free a place (a
// phone whose app was removed, or whose data was cleared, would otherwise
// keep it for 30 days).
export default function DevicesModal({ isOpen, onClose, onChanged }: { isOpen: boolean; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation("dashboard");
  const { t: tCommon } = useTranslation("common");
  const [confirm, confirmDialog] = useConfirm();
  const [devices, setDevices] = useState<LicensedDevice[] | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const thisDevice = deviceId();

  const load = useCallback(async () => {
    const result = await LicenseRepository.listDevices();
    if (result.success) setDevices(result.data ?? []);
    else setError(humanizeBackendError(result.message, tCommon) ?? t("devices.loadError"));
  }, [t, tCommon]);

  useEffect(() => {
    if (isOpen) {
      setDevices(null);
      setError("");
      void load();
    }
  }, [isOpen, load]);

  const remove = async (device: LicensedDevice) => {
    if (!(await confirm(t("devices.removeConfirm", { device: device.label ?? t(`devices.platform.${device.platform}`) })))) return;
    setRemoving(device.deviceId);
    const result = await LicenseRepository.removeDevice(device.deviceId);
    setRemoving(null);
    if (!result.success) {
      setError(humanizeBackendError(result.message, tCommon) ?? t("devices.removeError"));
      return;
    }
    await load();
    onChanged();
  };

  const when = (iso: string) => `${formatDateOnly(iso, i18n.language)} ${formatTimeOnly(iso, i18n.language)}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("devices.title")} size="md">
      <p className={styles.devicesHint}>{t("devices.hint")}</p>
      <ErrorText>{error}</ErrorText>
      {devices === null ? null : devices.length === 0 ? (
        <EmptyState message={t("devices.empty")} />
      ) : (
        <ul className={styles.devicesList}>
          {devices.map((device) => (
            <li key={device.deviceId} className={styles.deviceRow}>
              <span className={styles.deviceIcon} aria-hidden="true">
                {device.platform === "web" ? <Globe size={18} /> : <Smartphone size={18} />}
              </span>
              <span className={styles.deviceMain}>
                <span className={styles.deviceName}>
                  {device.label ?? t(`devices.platform.${device.platform}`)}
                  {device.deviceId === thisDevice ? <span className={styles.deviceThis}>{t("devices.thisDevice")}</span> : null}
                  {!device.counted ? <span className={styles.deviceIdle}>{t("devices.notCounted")}</span> : null}
                </span>
                <span className={styles.deviceMeta}>
                  {device.people.join("، ")} · {t("devices.lastSeen", { when: when(device.lastSeenAt) })}
                </span>
              </span>
              {device.deviceId !== thisDevice ? (
                <Button size="sm" variant="ghost" onClick={() => remove(device)} loading={removing === device.deviceId}>
                  {t("devices.remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </Modal>
  );
}
