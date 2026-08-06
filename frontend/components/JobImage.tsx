"use client";

import { useEffect, useState } from "react";
import { apiFetchObjectUrl } from "@/lib/api";

interface JobImageProps {
  jobId: string;
  kind: "raw" | "mask";
  alt: string;
  /** Shown when the image cannot be loaded. */
  fallbackLabel: string;
}

/**
 * Renders a job's stored scan or mask.
 *
 * The image endpoint is tenant-scoped behind the Bearer session, which an
 * <img src> cannot satisfy on its own, so the bytes are fetched as a blob and
 * handed over as an object URL.
 */
export function JobImage({ jobId, kind, alt, fallbackLabel }: JobImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    setSrc(null);
    setFailed(false);

    apiFetchObjectUrl(`/api/jobs/${jobId}/image/${kind}`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [jobId, kind]);

  if (failed) {
    return (
      <div
        className="preview-img"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "120px", color: "var(--text-muted)", fontSize: "0.8rem" }}
      >
        {fallbackLabel}
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className="preview-img"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "120px" }}
      >
        <div className="spinner" style={{ width: "1.5rem", height: "1.5rem", borderWidth: "2px" }} />
      </div>
    );
  }

  return <img src={src} alt={alt} className="preview-img" />;
}
