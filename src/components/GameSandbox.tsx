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

    // Validate that htmlCode is a fragment (not a complete HTML document)
    const validateFragment = (html: string): string[] => {
      const errors: string[] = [];
      
      // Check that html_code doesn't contain wrapper tags
      if (html.includes('<!DOCTYPE html>')) {
        errors.push('FRAGMENT ERROR: html_code should not contain <!DOCTYPE html>');
      }
      if (html.includes('<html')) {
        errors.push('FRAGMENT ERROR: html_code should not contain <html> tag');
      }
      if (html.includes('<head>')) {
        errors.push('FRAGMENT ERROR: html_code should not contain <head> tag');
      }
      if (html.includes('<body>')) {
        errors.push('FRAGMENT ERROR: html_code should not contain <body> tag');
      }
      
      return errors;
    };

    const fragmentErrors = validateFragment(htmlCode);
    if (fragmentErrors.length > 0 && onError) {
      fragmentErrors.forEach(error => onError(error));
    }

    // Assemble complete HTML from fragments
    const assembledHtml = `<!DOCTYPE html>
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

    // Validate assembled HTML structure
    const validateAssembledHTML = (html: string): string[] => {
      const errors: string[] = [];
      
      // Check for unclosed tags
      const divOpen = (html.match(/<div[^>]*>/g) || []).length;
      const divClose = (html.match(/<\/div>/g) || []).length;
      if (divOpen !== divClose) {
        errors.push(`ASSEMBLED HTML: Unclosed div tags (${divOpen} open, ${divClose} close)`);
      }
      
      // Check for multiple script tags in body (should only be our wrapper script)
      const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
      if (bodyMatch) {
        const bodyContent = bodyMatch[1];
        const scriptTagsInBody = (bodyContent.match(/<script[^>]*>/g) || []).length;
        if (scriptTagsInBody > 1) {
          errors.push(`ASSEMBLED HTML: Multiple script tags detected in body`);
        }
      }
      
      return errors;
    };

    const assembledErrors = validateAssembledHTML(assembledHtml);
    if (assembledErrors.length > 0 && onError) {
      assembledErrors.forEach(error => onError(error));
    }

    return assembledHtml;
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
          sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals"
          className="w-full h-full border-0 rounded-lg"
          title="Game Sandbox"
        />
      </div>
    </div>
  );
}
