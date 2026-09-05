import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

export function PluginLogo({
  iconUrl,
  name,
}: Readonly<{ iconKey?: string; iconUrl?: string; name: string }>) {
  const [failed, setFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = safeIconUrl(iconUrl);
  const clearFallbackTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    setFailed(false);
    clearFallbackTimer();
    if (source) {
      timeoutRef.current = setTimeout(() => setFailed(true), 5_000);
    }
    return clearFallbackTimer;
  }, [source]);

  return (
    <span aria-hidden="true" className="plugin-logo" data-plugin-name={name}>
      {source && !failed ? (
        <img
          alt=""
          src={source}
          onError={() => {
            clearFallbackTimer();
            setFailed(true);
          }}
          onLoad={clearFallbackTimer}
        />
      ) : (
        <span className="plugin-logo__fallback">{initials(name) || <Sparkles />}</span>
      )}
    </span>
  );
}

function safeIconUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("");
}
