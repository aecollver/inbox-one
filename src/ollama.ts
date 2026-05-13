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
  recommendation: string;
  reason: string;
};

const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5";

export async function classifyEmail(email: EmailForClassification): Promise<EmailClassification> {
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://172.20.176.1:11434";

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
            "Classify this e-mail as: School (Mitchell, McCullough, AST, College Park, general Conroe ISD or the club/activity), Security, Financial or Unknown.",
            "Recommend a priority level of low, normal or high.",
            "Recommend the follow up action: Reply Requested, Follow Up, Archive or Delete.",
            "When the follow up action is archive, suggest a retention period of 1 week, 1 month or 3 months.",
            "Respond as a JSON object with the following format: { category: string, subcategory: string, priority: string, retention: string, recommendation: string, reason: string }"
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

  console.log("test");
  if (!content) {
    throw new Error("Ollama response did not include message content.");
  }

  return JSON.parse(content) as EmailClassification;
}
