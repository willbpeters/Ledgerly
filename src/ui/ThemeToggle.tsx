import { Segmented } from "./components";
import { useTheme, type ThemePref } from "./theme";

export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <Segmented<ThemePref>
      items={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Auto" }]}
      value={pref} onChange={setPref} />
  );
}
