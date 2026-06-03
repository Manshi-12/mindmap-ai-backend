import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import { createRequire } from "module";

dotenv.config();

// Safe pdf-parse import
const require = createRequire(import.meta.url);
let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch (e) {
  console.warn("pdf-parse not available:", e.message);
}

const app = express();

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://mindmap-ai-studio.vercel.app",
    /\.vercel\.app$/,
  ],
  credentials: true,
}));

app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ── Lazy Cosmos DB (only connects when actually used, won't crash startup) ──
let cosmosContainer = null;
function getCosmosContainer() {
  if (cosmosContainer) return cosmosContainer;
  try {
    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
    cosmosContainer = client
      .database(process.env.COSMOS_DATABASE)
      .container(process.env.COSMOS_CONTAINER);
    return cosmosContainer;
  } catch (err) {
    console.error("Cosmos DB init failed:", err.message);
    return null;
  }
}

// ── Health check (important for Azure to know app is alive) ──
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "MindMap AI Backend is running" });
});

// ── Text chunker ──
function chunkText(text, chunkSize = 300) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
}

// ── Upload to Azure Search ──
async function uploadToSearch(documents) {
  await axios.post(
    `${process.env.AZURE_SEARCH_ENDPOINT}/indexes/${process.env.AZURE_SEARCH_INDEX}/docs/index?api-version=2023-11-01`,
    { value: documents.map((doc) => ({ "@search.action": "mergeOrUpload", ...doc })) },
    { headers: { "api-key": process.env.AZURE_SEARCH_KEY, "Content-Type": "application/json" } }
  );
}

// ── RAG ──
async function fetchContext(topic) {
  try {
    const response = await axios.get(
      `${process.env.AZURE_SEARCH_ENDPOINT}/indexes/${process.env.AZURE_SEARCH_INDEX}/docs`,
      {
        params: { "api-version": "2023-11-01", search: topic, $top: 3, $select: "content,source,topic" },
        headers: { "api-key": process.env.AZURE_SEARCH_KEY },
      }
    );
    const results = response.data.value;
    if (!results || results.length === 0) return "";
    results.forEach((r) => console.log(`  ↳ source: ${r.source || "manual"} | topic: ${r.topic}`));
    return results.map((r) => r.content).join("\n\n");
  } catch (err) {
    console.error("RAG fetch failed:", err.message);
    return "";
  }
}

// ── Validation ──
function isValidMindmap(data) {
  if (!data) return false;
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) return false;
  if (!Array.isArray(data.edges)) return false;
  for (const node of data.nodes) { if (!node.id || !node.label) return false; }
  for (const edge of data.edges) { if (!edge.from || !edge.to) return false; }
  if (!data.meta || typeof data.meta.confidence !== "number" || typeof data.meta.topic !== "string") return false;
  return true;
}

// ── AI helper ──
async function callAI(messages, temperature = 0.2) {
  const response = await axios.post(
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
    { messages, temperature },
    { headers: { "api-key": process.env.AZURE_OPENAI_API_KEY, "Content-Type": "application/json" } }
  );
  return response.data.choices[0].message.content;
}

async function generateStructure(topic, context) {
  let attempts = 0, errorReason = "";
  while (attempts < 3) {
    const dynamicInstruction = attempts > 0 ? `Previous attempt failed.\nReason: ${errorReason}\nFix and return correct JSON.` : "";
    try {
      const aiText = await callAI([
        {
          role: "system",
          content: `You are an expert knowledge architect and strict JSON generator.
Return ONLY valid JSON. No markdown, no explanation, no text outside JSON.

Format:
{
  "nodes": [ { "id": "1", "label": "Concise Label" } ],
  "edges": [ { "from": "1", "to": "2" } ],
  "meta": { "confidence": 0.9, "topic": "string" }
}

Rules:
- Labels: 1-4 words maximum, meaningful concepts
- First node (id "1") must be the main topic
- All edge "from"/"to" values must be existing node IDs
- No duplicate IDs
- topic in meta must match user input exactly
${dynamicInstruction}`,
        },
        {
          role: "user",
          content: `Create a mind map for the topic: "${topic}".
Node count: simple topics = 5 nodes, medium = 6-7, broad/complex = 8-10. Never fewer than 5, never more than 10.
${context ? `\n\nUse this background knowledge:\n${context}` : ""}`,
        },
      ]);
      let parsed;
      try { parsed = JSON.parse(aiText); } catch { errorReason = "Invalid JSON"; attempts++; continue; }
      if (isValidMindmap(parsed)) return parsed;
      errorReason = "Schema validation failed"; attempts++;
    } catch (err) { errorReason = "AI API error: " + err.message; attempts++; }
  }
  return null;
}

async function enrichNodes(structure, topic, context) {
  const nodeLabels = structure.nodes.map((n) => n.label).join(", ");
  try {
    const aiText = await callAI([
      {
        role: "system",
        content: `You are a precise knowledge explainer and strict JSON generator.
Return ONLY a JSON array. No text outside JSON. No markdown.
Format: [ { "label": "ExactNodeLabel", "description": "One sharp sentence, max 12 words." } ]
Rules: factual, specific, match label exactly, no filler phrases.`,
      },
      { role: "user", content: `Topic: ${topic}\nNodes: ${nodeLabels}\n${context ? `\nBackground:\n${context}` : ""}\nReturn descriptions for all nodes.` },
    ], 0.3);
    let descriptions;
    try { descriptions = JSON.parse(aiText); } catch { return structure; }
    const descMap = {};
    descriptions.forEach((d) => { descMap[d.label] = d.description; });
    structure.nodes = structure.nodes.map((n) => ({ ...n, description: descMap[n.label] || "" }));
    return structure;
  } catch { return structure; }
}

// ── POST /ai ──
app.post("/ai", async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: "topic is required" });
  try {
    const context = await fetchContext(topic);
    console.log("RAG context:", context ? "YES" : "NO");
    console.log("Step A: Generating structure...");
    const structure = await generateStructure(topic, context);
    if (!structure) {
      return res.json({ nodes: [{ id: "1", label: topic, description: "" }], edges: [], meta: { confidence: 0, topic } });
    }
    console.log("Step B: Enriching nodes...");
    const enriched = await enrichNodes(structure, topic, context);
    console.log("Done. Nodes:", enriched.nodes.length);
    return res.json(enriched);
  } catch (err) {
    console.error("POST /ai error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /explain ──
app.post("/explain", async (req, res) => {
  const { node, topic } = req.body;
  if (!node || !topic) return res.status(400).json({ error: "node and topic required" });
  try {
    const explanation = await callAI([
      {
        role: "system",
        content: `You are a clear expert explainer. Write 3-5 sentences about the concept.
- First: what it IS
- Second: how it WORKS or why it matters  
- Third: real-world example
No bullet points. One paragraph only.`,
      },
      { role: "user", content: `Topic: ${topic}\nExplain: ${node}` },
    ], 0.4);
    return res.json({ explanation });
  } catch (err) {
    console.error("POST /explain error:", err.message);
    return res.status(500).json({ error: "Failed to get explanation" });
  }
});

// ── POST /upload/pdf ──
app.post("/upload/pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!pdfParse) return res.status(500).json({ error: "PDF parsing not available" });
  const topic = req.body.topic || "general";
  try {
    const pdfData = await pdfParse(req.file.buffer);
    const chunks = chunkText(pdfData.text, 300);
    const docs = chunks.map((chunk, i) => ({
      id: `pdf-${topic.replace(/\s+/g, "_")}-${Date.now()}-${i}`,
      topic, content: chunk, source: "pdf",
    }));
    const container = getCosmosContainer();
    if (container) {
      for (const doc of docs) await container.items.create(doc);
    }
    await uploadToSearch(docs);
    return res.json({ message: "PDF processed successfully", chunks: chunks.length, topic });
  } catch (err) {
    console.error("PDF upload error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /upload/cosmos ──
app.post("/upload/cosmos", async (req, res) => {
  const { topic, content } = req.body;
  if (!topic || !content) return res.status(400).json({ error: "topic and content required" });
  try {
    const doc = { id: `cosmos-${topic.replace(/\s+/g, "_")}-${Date.now()}`, topic, content, source: "cosmos" };
    const container = getCosmosContainer();
    if (container) await container.items.create(doc);
    await uploadToSearch([doc]);
    return res.json({ message: "Document added", id: doc.id });
  } catch (err) {
    return res.status(500).json({ error: "Failed to add document" });
  }
});

// ── GET /knowledge ──
app.get("/knowledge", async (req, res) => {
  try {
    const container = getCosmosContainer();
    if (!container) return res.json({ count: 0, documents: [], note: "Cosmos DB not connected" });
    const { resources } = await container.items
      .query("SELECT c.id, c.topic, c.source, LEFT(c.content, 100) as preview FROM c")
      .fetchAll();
    return res.json({ count: resources.length, documents: resources });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch documents" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));