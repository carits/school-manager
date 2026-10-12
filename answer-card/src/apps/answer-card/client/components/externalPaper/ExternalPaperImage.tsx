import React, { useEffect, useState } from "react";
import { authFetch } from "../../auth/api";
export function ExternalPaperImage({ url, alt, style, children }: { url: string; alt: string; style?: React.CSSProperties; children?: React.ReactNode }) {
  const [source, setSource] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    setSource(""); setError("");
    void authFetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("图片加载失败，请刷新或检查扫描状态");
      const blob = await response.blob(); if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setSource(objectUrl);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  return error ? <p role="alert">{error}</p> : source ? <div style={{ position: "relative", ...style }}><img src={source} alt={alt} style={{ width: "100%", height: "auto", display: "block" }} />{children}</div> : <p>图片加载中…</p>;
}
