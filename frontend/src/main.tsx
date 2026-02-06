import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Toaster } from "@/components/ui/sonner";

// Global error handler for unhandled errors
window.onerror = (message, source, lineno, colno, error) => {
  console.error("Global error:", { message, source, lineno, colno, error });

  // Log to localStorage for debugging
  try {
    const errorLog = {
      type: "unhandled_error",
      timestamp: new Date().toISOString(),
      message: String(message),
      source,
      lineno,
      colno,
      stack: error?.stack,
    };
    const existingLogs = JSON.parse(
      localStorage.getItem("spotiflac_error_logs") || "[]",
    );
    existingLogs.push(errorLog);
    // Keep only last 10 errors
    if (existingLogs.length > 10) {
      existingLogs.shift();
    }
    localStorage.setItem("spotiflac_error_logs", JSON.stringify(existingLogs));
  } catch {
    // Ignore localStorage errors
  }

  // Return false to allow the error to propagate to the console
  return false;
};

// Global handler for unhandled promise rejections
window.onunhandledrejection = (event) => {
  console.error("Unhandled promise rejection:", event.reason);

  // Log to localStorage for debugging
  try {
    const errorLog = {
      type: "unhandled_promise_rejection",
      timestamp: new Date().toISOString(),
      reason:
        event.reason instanceof Error
          ? { message: event.reason.message, stack: event.reason.stack }
          : String(event.reason),
    };
    const existingLogs = JSON.parse(
      localStorage.getItem("spotiflac_error_logs") || "[]",
    );
    existingLogs.push(errorLog);
    // Keep only last 10 errors
    if (existingLogs.length > 10) {
      existingLogs.shift();
    }
    localStorage.setItem("spotiflac_error_logs", JSON.stringify(existingLogs));
  } catch {
    // Ignore localStorage errors
  }

  // Prevent the error from crashing the app
  event.preventDefault();
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster position="bottom-left" duration={1000} />
  </StrictMode>,
);
