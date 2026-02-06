import { useState, useEffect, useRef } from "react";
import { Trash2, Copy, Check, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { logger, type LogEntry } from "@/lib/logger";

interface ErrorLog {
  type?: string;
  timestamp: string;
  message?: string;
  error?: string;
  stack?: string;
  componentStack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  reason?: { message: string; stack?: string } | string;
}

const levelColors: Record<string, string> = {
  info: "text-blue-500",
  success: "text-green-500",
  warning: "text-yellow-500",
  error: "text-red-500",
  debug: "text-gray-500",
};

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimestamp(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return timestamp;
  }
}

export function DebugLoggerPage() {
  const [logs, setLogs] = useState<LogEntry[]>(() => logger.getLogs());
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>(() => {
    try {
      const saved = localStorage.getItem("spotiflac_error_logs");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // Ignore
    }
    return [];
  });
  const [copied, setCopied] = useState(false);
  const [copiedErrors, setCopiedErrors] = useState(false);
  const [activeTab, setActiveTab] = useState<"debug" | "errors">("debug");
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadErrorLogs = () => {
    try {
      const saved = localStorage.getItem("spotiflac_error_logs");
      if (saved) {
        setErrorLogs(JSON.parse(saved));
      } else {
        setErrorLogs([]);
      }
    } catch {
      setErrorLogs([]);
    }
  };

  // Subscribe to log updates
  useEffect(() => {
    const unsubscribe = logger.subscribe(() => {
      setLogs(logger.getLogs());
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, errorLogs, activeTab]);

  const handleClear = () => {
    logger.clear();
  };

  const handleClearErrors = () => {
    localStorage.removeItem("spotiflac_error_logs");
    setErrorLogs([]);
  };

  const handleCopy = async () => {
    const logText = logs
      .map(
        (log) => `[${formatTime(log.timestamp)}] [${log.level}] ${log.message}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 500);
    } catch (err) {
      console.error("Failed to copy logs:", err);
    }
  };

  const handleCopyErrors = async () => {
    const errorText = errorLogs
      .map((log) => {
        const lines = [`[${formatTimestamp(log.timestamp)}]`];
        if (log.type) lines.push(`Type: ${log.type}`);
        if (log.message) lines.push(`Message: ${log.message}`);
        if (log.error) lines.push(`Error: ${log.error}`);
        if (log.stack) lines.push(`Stack: ${log.stack}`);
        if (log.componentStack)
          lines.push(`Component Stack: ${log.componentStack}`);
        if (log.reason) {
          if (typeof log.reason === "string") {
            lines.push(`Reason: ${log.reason}`);
          } else {
            lines.push(`Reason: ${log.reason.message}`);
            if (log.reason.stack) lines.push(`Stack: ${log.reason.stack}`);
          }
        }
        return lines.join("\n");
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(errorText);
      setCopiedErrors(true);
      setTimeout(() => setCopiedErrors(false), 500);
    } catch (err) {
      console.error("Failed to copy error logs:", err);
    }
  };

  const getErrorMessage = (log: ErrorLog): string => {
    if (log.message) return log.message;
    if (log.error) return log.error;
    if (log.reason) {
      if (typeof log.reason === "string") return log.reason;
      return log.reason.message;
    }
    return "Unknown error";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Debug Logs</h1>
        <div className="flex items-center gap-2">
          {activeTab === "debug" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleCopy}
                disabled={logs.length === 0}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleClear}
                disabled={logs.length === 0}
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={loadErrorLogs}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleCopyErrors}
                disabled={errorLogs.length === 0}
              >
                {copiedErrors ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleClearErrors}
                disabled={errorLogs.length === 0}
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b pb-2">
        <Button
          variant={activeTab === "debug" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("debug")}
        >
          Debug Logs
          {logs.length > 0 && (
            <Badge variant="secondary" className="ml-2">
              {logs.length}
            </Badge>
          )}
        </Button>
        <Button
          variant={activeTab === "errors" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("errors")}
          className={errorLogs.length > 0 ? "text-red-500" : ""}
        >
          <AlertTriangle className="h-4 w-4 mr-1.5" />
          Error Logs
          {errorLogs.length > 0 && (
            <Badge variant="destructive" className="ml-2">
              {errorLogs.length}
            </Badge>
          )}
        </Button>
      </div>

      {activeTab === "debug" ? (
        <div
          ref={scrollRef}
          className="h-[calc(100vh-280px)] overflow-y-auto bg-muted/50 rounded-lg p-4 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <p className="text-muted-foreground lowercase">no logs yet...</p>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="text-muted-foreground shrink-0">
                  [{formatTime(log.timestamp)}]
                </span>
                <span className={`shrink-0 w-16 ${levelColors[log.level]}`}>
                  [{log.level}]
                </span>
                <span className="break-all">{log.message}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="h-[calc(100vh-280px)] overflow-y-auto bg-muted/50 rounded-lg p-4 space-y-4"
        >
          {errorLogs.length === 0 ? (
            <div className="text-center py-8">
              <AlertTriangle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">No crash logs recorded</p>
              <p className="text-xs text-muted-foreground mt-1">
                Errors will be logged here when the app encounters issues
              </p>
            </div>
          ) : (
            errorLogs.map((log, i) => (
              <div
                key={i}
                className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <Badge variant="destructive" className="text-xs">
                    {log.type || "error"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatTimestamp(log.timestamp)}
                  </span>
                </div>
                <p className="font-medium text-red-500 text-sm">
                  {getErrorMessage(log)}
                </p>
                {log.stack && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Stack trace
                    </summary>
                    <pre className="mt-2 p-2 bg-muted rounded text-[10px] overflow-x-auto whitespace-pre-wrap">
                      {log.stack}
                    </pre>
                  </details>
                )}
                {log.componentStack && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Component stack
                    </summary>
                    <pre className="mt-2 p-2 bg-muted rounded text-[10px] overflow-x-auto whitespace-pre-wrap">
                      {log.componentStack}
                    </pre>
                  </details>
                )}
                {log.source && (
                  <p className="text-xs text-muted-foreground">
                    Source: {log.source}
                    {log.lineno && `:${log.lineno}`}
                    {log.colno && `:${log.colno}`}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === "errors" && errorLogs.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          These logs can help diagnose crashes. Copy and share them when
          reporting issues.
        </p>
      )}
    </div>
  );
}
