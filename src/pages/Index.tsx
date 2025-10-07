import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import ChatPanel from "@/components/ChatPanel";
import GameSandbox from "@/components/GameSandbox";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
interface Message {
  role: "user" | "assistant";
  content: string;
}
export default function Index() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [htmlCode, setHtmlCode] = useState("");
  const [cssCode, setCssCode] = useState("");
  const [jsCode, setJsCode] = useState("");
  const [status, setStatus] = useState<string>("initial");
  const [isLoading, setIsLoading] = useState(false);
  const handleError = useCallback(async (error: string) => {
    console.error("Game error:", error);
    if (sessionId) {
      try {
        await supabase.functions.invoke("update-errors", {
          body: {
            sessionId,
            errorLog: error
          }
        });
        toast.error("Game Error Detected", {
          description: "The AI is analyzing the error..."
        });
      } catch (err) {
        console.error("Failed to update error log:", err);
      }
    }
  }, [sessionId]);
  const refreshGameCode = useCallback(async (sid: string) => {
    try {
      // @ts-ignore - table exists but types need regeneration
      const result = await supabase
      // @ts-ignore
      .from("game_sessions").select("html_code, css_code, js_code, status, chat_history").eq("id", sid).maybeSingle();
      const {
        data,
        error
      } = result;
      if (error) throw error;
      if (!data) {
        throw new Error("Session not found");
      }

      // @ts-ignore
      setHtmlCode(data.html_code || "");
      // @ts-ignore
      setCssCode(data.css_code || "");
      // @ts-ignore
      setJsCode(data.js_code || "");
      // @ts-ignore
      setStatus(data.status || "initial");
      // @ts-ignore
      const history = data.chat_history;
      if (Array.isArray(history)) {
        setChatHistory(history as unknown as Message[]);
      }
    } catch (error: any) {
      console.error("Error refreshing game code:", error);
      toast.error("Failed to refresh game", {
        description: error.message
      });
    }
  }, []);
  const handleSendMessage = useCallback(async (message: string) => {
    setIsLoading(true);
    try {
      // Initial game creation
      if (!sessionId) {
        const {
          data: initData,
          error: initError
        } = await supabase.functions.invoke("initialize-game", {
          body: {
            userPrompt: message
          }
        });
        if (initError) throw initError;
        const newSessionId = initData.sessionId;
        setSessionId(newSessionId);
        setChatHistory([{
          role: "user",
          content: message
        }, {
          role: "assistant",
          content: initData.gamePlan.chat_response
        }]);
        toast.success("Game Plan Created", {
          description: "Now generating the initial game..."
        });

        // Generate initial code
        const {
          data: orchData,
          error: orchError
        } = await supabase.functions.invoke("orchestrate-changes", {
          body: {
            sessionId: newSessionId,
            userPrompt: "Generate the initial HTML, CSS, and JavaScript for the game based on the plan, and generate all required images."
          }
        });
        if (orchError) {
          console.error('Orchestration error:', orchError);

          // Check for rate limiting
          if (orchError.message?.includes('429') || orchError.message?.includes('rate limit')) {
            toast.error('Rate limit exceeded. Please wait a moment before trying again.');
          } else {
            toast.error(`Error: ${orchError.message || 'Failed to process request'}`);
          }
          throw orchError;
        }

        // Execute tool calls
        const {
          error: execError
        } = await supabase.functions.invoke("execute-tool-calls", {
          body: {
            sessionId: newSessionId,
            toolCalls: orchData.toolCalls
          }
        });
        if (execError) throw execError;
        await refreshGameCode(newSessionId);
        toast.success("Game Created!", {
          description: "Your game is ready. Try it out!"
        });
      } else {
        // Iteration: user feedback
        setChatHistory(prev => [...prev, {
          role: "user",
          content: message
        }]);
        const {
          data: orchData,
          error: orchError
        } = await supabase.functions.invoke("orchestrate-changes", {
          body: {
            sessionId,
            userPrompt: message
          }
        });
        if (orchError) {
          console.error('Orchestration error:', orchError);

          // Check for rate limiting
          if (orchError.message?.includes('429') || orchError.message?.includes('rate limit')) {
            toast.error('Rate limit exceeded. Please wait a moment before trying again.');
          } else {
            toast.error(`Error: ${orchError.message || 'Failed to process request'}`);
          }
          throw orchError;
        }
        const {
          data: execData,
          error: execError
        } = await supabase.functions.invoke("execute-tool-calls", {
          body: {
            sessionId,
            toolCalls: orchData.toolCalls
          }
        });
        if (execError) throw execError;
        await refreshGameCode(sessionId);
        toast.success("Game Updated", {
          description: execData.chatResponse || "Changes applied successfully!"
        });
      }
    } catch (error: any) {
      console.error("Error sending message:", error);
      toast.error("Something went wrong", {
        description: error.message || "Please try again"
      });
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, refreshGameCode]);
  return <div className="h-screen flex flex-col">
      <header className="bg-card border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary via-primary-glow to-accent bg-clip-text text-transparent">
              AI Game Dev Agent
            </h1>
            <p className="text-sm text-muted-foreground">Iterative game development powered by AI!</p>
          </div>
          {status !== "initial" && <div className="px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm">
              {status.replace(/_/g, " ")}
            </div>}
        </div>
      </header>

      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel defaultSize={35} minSize={25}>
          <ChatPanel chatHistory={chatHistory} onSendMessage={handleSendMessage} isLoading={isLoading} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={65} minSize={35}>
          <div className="h-full p-4">
            <GameSandbox htmlCode={htmlCode} cssCode={cssCode} jsCode={jsCode} onError={handleError} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>;
}