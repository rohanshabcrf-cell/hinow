import { useMemo, useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import { AlertCircle, Code2 } from "lucide-react";

interface GameSandboxProps {
  htmlCode: string;
  cssCode: string;
  jsCode: string;
  onError?: (error: string) => void;
}

export default function GameSandbox({ htmlCode, cssCode, jsCode, onError }: GameSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const constructedHtml = useMemo(() => {
    if (!htmlCode) return "";

    // Validate HTML structure before rendering
    const validateStructure = (html: string): string[] => {
      const errors: string[] = [];
      
      // Check for basic required elements
      if (!html.includes('<!DOCTYPE html>') && !html.includes('<html')) {
        errors.push('STRUCTURAL: Missing HTML document structure');
      }
      
      // Check for unclosed tags
      const divOpen = (html.match(/<div[^>]*>/g) || []).length;
      const divClose = (html.match(/<\/div>/g) || []).length;
      if (divOpen !== divClose) {
        errors.push(`STRUCTURAL: Unclosed div tags (${divOpen} open, ${divClose} close)`);
      }
      
      // Check for style tag placement
      if (html.includes('<style>') && html.indexOf('<style>') > html.indexOf('<body>')) {
        errors.push('STRUCTURAL: <style> tag found in body instead of head');
      }
      
      // Check for script tag placement
      const scriptInHead = html.indexOf('<script>') < html.indexOf('</head>');
      if (scriptInHead) {
        errors.push('WARNING: <script> tag in head may cause issues');
      }
      
      return errors;
    };

    const structuralErrors = validateStructure(htmlCode);
    if (structuralErrors.length > 0 && onError) {
      structuralErrors.forEach(error => onError(error));
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    ${cssCode || ""}
  </style>
</head>
<body>
  ${htmlCode}
  <script>
    // Error capturing - JavaScript Runtime
    window.onerror = function(message, source, lineno, colno, error) {
      window.parent.postMessage({
        type: 'game_error',
        error: 'JS RUNTIME: ' + message + ' at ' + source + ':' + lineno + ':' + colno
      }, '*');
      return true;
    };

    window.addEventListener('unhandledrejection', function(event) {
      window.parent.postMessage({
        type: 'game_error',
        error: 'JS PROMISE: Unhandled Promise Rejection: ' + event.reason
      }, '*');
    });

    // DOM Validation - Check if expected elements exist
    window.addEventListener('DOMContentLoaded', function() {
      const expectedElements = document.querySelectorAll('[id]');
      if (expectedElements.length === 0) {
        window.parent.postMessage({
          type: 'game_error',
          error: 'DOM VALIDATION: No elements with IDs found - possible HTML corruption'
        }, '*');
      }
      
      // Check for orphaned script/style tags in body
      const bodyScripts = document.body.querySelectorAll('script');
      const bodyStyles = document.body.querySelectorAll('style');
      if (bodyScripts.length > 1) {
        window.parent.postMessage({
          type: 'game_error',
          error: 'DOM WARNING: Multiple script tags in body detected'
        }, '*');
      }
      if (bodyStyles.length > 0) {
        window.parent.postMessage({
          type: 'game_error',
          error: 'DOM WARNING: Style tags found in body instead of head'
        }, '*');
      }
    });

    // Game code
    ${jsCode || ""}
  </script>
</body>
</html>`;
  }, [htmlCode, cssCode, jsCode, onError]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "game_error" && onError) {
        onError(event.data.error);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onError]);

  if (!htmlCode) {
    return (
      <Card className="h-full flex items-center justify-center bg-card/50 border-border">
        <div className="text-center p-8">
          <Code2 className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
          <h3 className="text-lg font-semibold mb-2">No Game Yet</h3>
          <p className="text-muted-foreground">
            Describe your game idea in the chat to get started
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 relative">
        <iframe
          ref={iframeRef}
          srcDoc={constructedHtml}
          sandbox="allow-scripts allow-forms allow-pointer-lock allow-same-origin allow-popups allow-modals"
          className="w-full h-full border-0 rounded-lg"
          title="Game Sandbox"
        />
      </div>
    </div>
  );
}
