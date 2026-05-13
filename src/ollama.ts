export type EmailForClassification = {
  accountName: string;
  from?: string;
  subject: string;
  date?: string;
  preview?: string;
};

export type EmailClassification = {
  category: string;
  priority: "low" | "normal" | "high";
  reason: string;
};

const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5";

export async function classifyEmail(email: EmailForClassification): Promise<EmailClassification> {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: [
            "Classify email into one category.",
            "Return only JSON with keys: category, priority, reason.",
            "priority must be one of: low, normal, high.",
            "Use concise category names like action, finance, receipt, newsletter, personal, spam, travel, work, security, or unknown.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(email),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content;

  if (!content) {
    throw new Error("Ollama response did not include message content.");
  }

  return JSON.parse(content) as EmailClassification;
}
