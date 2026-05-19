import { getUserLanguage, setUserLanguage, getMessage, applyLanguageUI } from "./i18n.js";

const langSelector = document.querySelector("#langSelector");
const savedMsg = document.querySelector("#savedMsg");

async function init() {
  const lang = await getUserLanguage();
  langSelector.value = lang.startsWith("zh") ? "zh_CN" : "en";
  await applyLanguageUI();
}

langSelector.addEventListener("change", async () => {
  const lang = langSelector.value;
  await setUserLanguage(lang);
  await applyLanguageUI();
  savedMsg.textContent = getMessage("settingsSaved");
  savedMsg.classList.add("visible");
  window.setTimeout(() => savedMsg.classList.remove("visible"), 2000);
});

init();
