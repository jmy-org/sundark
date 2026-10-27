// Same-origin bootstrap for the pinned upstream reader, not a replacement frontend.
try {
  window.pdfjsLib = await import("/vendor/pdf/pdf.mjs");
  await import("/sundark-original/adapter.js");
  if (typeof window.sundarkFetch !== "function") throw new Error("개인 서재 연결 어댑터를 준비하지 못했어요.");
  await import("/sundark-original/app.js");
} catch (error) {
  document.getElementById("prep-overlay")?.classList.add("hidden");
  const banner = document.getElementById("ai-banner");
  if (banner) { banner.textContent = "리더 초기화 실패: " + (error?.message || "다시 시도해 주세요."); banner.classList.remove("hidden"); }
}
