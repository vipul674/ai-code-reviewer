import * as vscode from "vscode";

export interface ReviewResponse {
  success: boolean;
  response?: string;
  error?: string;
}

export interface ReviewItem {
  type: string;
  line: number;
  description: string;
  suggestion: string;
}

export interface FileReview {
  bugs: ReviewItem[];
  security: ReviewItem[];
  optimization: ReviewItem[];
  styling: ReviewItem[];
}

export interface AnalysisData {
  fileReviews: Record<string, FileReview>;
}

export interface BackendResponse {
  success: boolean;
  analysis: AnalysisData;
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("reposage");
  const apiUrl = config.get<string>("apiUrl", "http://localhost:5000");
  return { apiUrl };
}

export async function reviewFileContent(
  fileName: string,
  content: string,
  apiKey: string
): Promise<ReviewResponse> {
  const { apiUrl } = getConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  try {
    const response = await fetch(`${apiUrl}/api/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: content,
        fileName: fileName,
        company: "General",
        language: "English",
        model: "llama-3.3-70b-versatile",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `API error (${response.status}): ${errorText}`,
      };
    }

    const data = await response.json();
    console.log("RepoSage API response:", data);
    return { success: true, response: JSON.stringify(data, null, 2) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("RepoSage API fetch failed:", err);
    return {
      success: false,
      error: `Failed to reach RepoSage backend at ${apiUrl}: ${message}`,
    };
  }
}
