import PageShell from "../../components/common/PageShell";
import ClockInOutCard from "../dashboard/ClockInOutCard";
import clockInOutHeaderImage from "../../assets/illustration-clockinout-header.png";

// § user-directed - "the Owner/Manager shouldn't have the clock-in
// widget on their own Dashboard the way an Employee does - a sidebar
// entry that takes them to a dedicated page is more logical." Same
// ClockInOutCard every Employee already uses on their own Dashboard -
// this page is purely a different place to reach it from, not a
// second implementation.
export default function ClockInPage() {
  return (
    <PageShell title="">
      <img
        src={clockInOutHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "3.8cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

      <ClockInOutCard />
    </PageShell>
  );
}
