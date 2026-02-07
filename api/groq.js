export const config = {
  runtime: "edge",
};

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function sanitizeCommonBreakers(s) {
  return s
    // Unicode line/paragraph separators that break JSON.parse in some environments
    .replace(/\u2028/g, "\\n")
    .replace(/\u2029/g, "\\n")
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, "$1");
}

// If model outputs real newlines inside JSON strings (illegal),
// this attempts to convert those to \n without touching structure too much.
// It’s a best-effort repair, not perfect, but helps in practice.
function escapeNewlinesInsideStrings(jsonStr) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      // Convert raw newlines/tabs inside strings to escaped forms
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        // drop or normalize CR
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    } else {
      if (ch === '"') {
        out += ch;
        inString = true;
        continue;
      }
      out += ch;
    }
  }

  return out;
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  try {
    const body = await req.json();
    const { system, messages } = body || {};

    // Build messages array for Groq
    const groqMessages = [];
    if (system) groqMessages.push({ role: "system", content: system });
    if (Array.isArray(messages)) groqMessages.push(...messages);

    // (Optional but recommended) Add a final guard instruction to reduce JSON breakage
    groqMessages.push({
      role: "user",
      content:
        "FINAL OUTPUT REQUIREMENTS:\n" +
        "- Output ONLY valid JSON.\n" +
        '- Do NOT use the double quote character (") inside post text. Use single quotes instead.\n' +
        "- Do NOT include trailing commas.\n" +
        "- Any line breaks inside JSON strings must be written as \\n, not real newlines.\n",
    });

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-maverick-17b-128e-instruct",
          messages: groqMessages,
          max_tokens: 5000,
          temperature: 0.8,
          top_p: 0.95,
          // Do not set stop sequences for JSON generation
        }),
      }
    );

    const data = await response.json();

    if (data?.error) {
      return new Response(JSON.stringify({ error: data.error }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const rawText = data?.choices?.[0]?.message?.content || "";

    // Try to parse JSON server-side so the frontend never breaks.
    // If parsing fails, return the raw text in Claude-like format as a fallback.
    const candidateJson = extractJsonObject(rawText);

    if (candidateJson) {
      const cleaned = escapeNewlinesInsideStrings(
        sanitizeCommonBreakers(candidateJson)
      );

      try {
        const parsed = JSON.parse(cleaned);

        // Return parsed JSON directly (recommended)
        // Your frontend can simply treat `data` as the parsed object.
        return new Response(JSON.stringify(parsed), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        // Fall through to raw response format
      }
    }

    // Fallback: Claude-like format so your existing HTML can still attempt to parse
    const transformedResponse = {
      content: [{ type: "text", text: rawText }],
    };

    return new Response(JSON.stringify(transformedResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error?.message || String(error) }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
