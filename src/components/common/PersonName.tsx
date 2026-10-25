import Avatar, { type AvatarSize } from "./Avatar";

// v2.3.43 step 14 (item 17): a name with its avatar, for lists and tables.
export default function PersonName({ name, userId, url, size = "sm", children }: { name: string; userId?: string | null; url?: string | null; size?: AvatarSize; children?: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
      <Avatar name={name} userId={userId} url={url} size={size} />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children ?? name}</span>
    </span>
  );
}
