"use client";

import React, { useState, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { JobImage } from "./JobImage";
import { UploadCloud, CheckCircle, AlertTriangle, Cpu, Sparkles } from "lucide-react";

interface JobInfo {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";
  rawImageS3Key: string;
  maskImageS3Key?: string | null;
  errorMessage?: string | null;
  modelVersion?: string | null;
  gpuSeconds?: number | null;
}

interface MaskUploaderProps {
  onJobCreated: () => void;
  activeJob: JobInfo | null;
  onJobFinalized: () => void;
}

export function MaskUploader({ onJobCreated, activeJob, onJobFinalized }: MaskUploaderProps) {
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  /**
   * Enforces that exactly 1 image is uploaded at a time.
   */
  const handleFiles = async (files: FileList) => {
    setError(null);

    // Rule: upload exactly 1 image at a time
    if (files.length !== 1) {
      setError("Please select exactly 1 raw image file at a time.");
      return;
    }

    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setError("Unauthorized file format. Please upload an image file (PNG/JPG).");
      return;
    }

    setUploading(true);
    setUploadProgress("Reserving organization credit...");

    try {
      // 1. Request presigned URL and reserve credit
      const requestRes = await apiFetch("/api/jobs/request", {
        method: "POST",
      });

      const { uploadUrl } = requestRes;
      setUploadProgress("Uploading raw image directly to storage...");

      // 2. Upload file directly to storage. That is the last step: completing
      // the upload is what queues the job, so there is no third call and no
      // window in which a stored image has nothing scheduled to process it.
      // Closing the tab here can no longer strand the reserved credit.
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadRes.ok) {
        // The storage layer rejects an oversized or non-PNG body and settles
        // the job itself, so the credit is already back.
        const detail = await uploadRes.json().catch(() => null);
        throw new Error(detail?.error || `Storage upload failed with code ${uploadRes.status}`);
      }

      setUploadProgress(null);
      onJobCreated();

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to complete image masking pipeline initialization");
      setUploading(false);
    }
  };

  // Reset uploader state to allow another upload
  const handleReset = () => {
    setUploading(false);
    setError(null);
    setUploadProgress(null);
    onJobFinalized();
  };

  return (
    <div className="glass-card">
      <div className="card-header">
        <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>AI Mask Generation</h2>
        {activeJob && (
          <span className={`badge ${
            activeJob.status === "PENDING" ? "badge-amber" :
            activeJob.status === "PROCESSING" ? "badge-teal" :
            activeJob.status === "SUCCESS" ? "badge-emerald" : "badge-red"
          }`}>
            {activeJob.status}
          </span>
        )}
      </div>

      {error && (
        <div className="callout callout-error" style={{ marginBottom: "1.5rem" }}>
          <AlertTriangle size={18} style={{ flexShrink: 0 }} />
          <div style={{ fontSize: "0.85rem" }}>{error}</div>
        </div>
      )}

      {/* Upload trigger panel */}
      {!uploading && !activeJob && (
        <div
          id="dropzone-box"
          className={`uploader-box ${dragActive ? "dragover" : ""}`}
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={triggerFileInput}
        >
          <input
            id="raw-image-file"
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            onChange={handleFileChange}
            accept="image/*"
          />
          <UploadCloud size={48} className="uploader-icon" />
          <div>
            <p style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.25rem" }}>
              Drag &amp; drop raw scan, or <span style={{ color: "var(--accent-teal)" }}>browse</span>
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
              Supports exactly 1 RAW or standard medical scan image at a time
            </p>
          </div>
        </div>
      )}

      {/* Uploading progress panel */}
      {uploading && !activeJob && (
        <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <div className="spinner" style={{ marginBottom: "1.5rem" }} />
          <p style={{ fontWeight: 500 }}>{uploadProgress || "Uploading..."}</p>
        </div>
      )}

      {/* Queue processing panel (PENDING / PROCESSING) */}
      {activeJob && (activeJob.status === "PENDING" || activeJob.status === "PROCESSING") && (
        <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <div className="spinner" style={{ marginBottom: "1.5rem" }} />
          <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", color: "var(--accent-teal)", fontWeight: 600, marginBottom: "0.5rem" }}>
            <Cpu size={18} />
            <span>GPU Workers Segmenting...</span>
          </div>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            {activeJob.status === "PENDING" ? "Waiting in broker queue..." : "Model analyzing scan on isolated GPU node..."}
          </p>
        </div>
      )}

      {/* Success preview panels */}
      {activeJob && activeJob.status === "SUCCESS" && (
        <div>
          <div className="callout callout-info" style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.2)", color: "#a7f3d0" }}>
            <CheckCircle size={18} style={{ color: "#10b981" }} />
            <div style={{ fontSize: "0.85rem" }}>
              <strong>Mask Generated:</strong> Processing completed. 1 credit consumed.
              {activeJob.modelVersion && (
                <div style={{ marginTop: "0.35rem", color: "var(--text-secondary)", fontSize: "0.78rem" }}>
                  Produced by <code style={{ fontFamily: "monospace" }}>{activeJob.modelVersion}</code>
                  {activeJob.gpuSeconds != null && ` in ${activeJob.gpuSeconds.toFixed(2)}s of GPU time`}
                </div>
              )}
            </div>
          </div>

          <div className="preview-layout">
            <div className="preview-panel">
              <span className="preview-title">Input Subject Scan</span>
              <JobImage jobId={activeJob.id} kind="raw" alt="Input Raw" fallbackLabel="Scan unavailable" />
            </div>
            <div className="preview-panel">
              <span className="preview-title">Segmented Mask Output</span>
              <JobImage jobId={activeJob.id} kind="mask" alt="Segmented Mask" fallbackLabel="Mask unavailable" />
            </div>
          </div>

          <button
            id="reset-uploader-btn"
            className="btn btn-secondary"
            style={{ width: "100%", marginTop: "1.5rem" }}
            onClick={handleReset}
          >
            Upload Another Image
          </button>
        </div>
      )}

      {/* Failure preview panel */}
      {activeJob && activeJob.status === "FAILED" && (
        <div style={{ textAlign: "center", padding: "2rem 1rem" }}>
          <div style={{ display: "inline-flex", padding: "10px", background: "rgba(239,68,68,0.1)", borderRadius: "50%", marginBottom: "1rem" }}>
            <AlertTriangle size={32} style={{ color: "var(--accent-red)" }} />
          </div>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "0.5rem" }}>Processing Failed</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
            {activeJob.errorMessage || "GPU Node encountered an internal segmentation failure."}
          </p>
          <div className="callout callout-info" style={{ marginBottom: "1.5rem", textAlign: "left" }}>
            <Sparkles size={18} style={{ color: "#00f2fe", flexShrink: 0 }} />
            <div style={{ fontSize: "0.8rem" }}>
              <strong>Transaction Safety:</strong> Credit balance was <strong>refunded</strong> back to your organization pool.
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={handleReset}>
            Retry Upload
          </button>
        </div>
      )}

    </div>
  );
}
