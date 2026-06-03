import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const documents = [
  { id: "1", topic: "blockchain", content: "Blockchain is a distributed ledger technology. It uses consensus mechanisms like Proof of Work and Proof of Stake. Key concepts include decentralization, smart contracts, nodes, cryptographic hashing, and immutability." },
  { id: "2", topic: "machine learning", content: "Machine learning is a subset of AI where systems learn from data. Core concepts include supervised learning, unsupervised learning, neural networks, training data, overfitting, regularization, and model evaluation metrics." },
  { id: "3", topic: "react", content: "React is a JavaScript library for building user interfaces. Key concepts include components, props, state, hooks like useState and useEffect, virtual DOM, reconciliation, and the component lifecycle." },
  { id: "4", topic: "climate change", content: "Climate change refers to long-term shifts in global temperatures and weather patterns. Key topics include greenhouse gases, carbon emissions, renewable energy, sea level rise, deforestation, and international climate agreements like the Paris Accord." },
  { id: "5", topic: "artificial intelligence", content: "Artificial intelligence is the simulation of human intelligence by machines. It covers machine learning, deep learning, natural language processing, computer vision, reinforcement learning, and ethical AI considerations." },
  { id: "6", topic: "nodejs", content: "Node.js is a JavaScript runtime built on Chrome's V8 engine. Key concepts include event loop, non-blocking I/O, npm packages, Express framework, middleware, REST APIs, streams, and asynchronous programming with callbacks and promises." },
  { id: "7", topic: "cybersecurity", content: "Cybersecurity protects systems and networks from digital attacks. Core concepts include encryption, firewalls, penetration testing, phishing, zero-trust architecture, SSL/TLS, authentication, and vulnerability management." },
  { id: "8", topic: "cloud computing", content: "Cloud computing delivers computing services over the internet. Key concepts include IaaS, PaaS, SaaS, virtual machines, containerization, serverless functions, auto-scaling, load balancing, and cloud providers like AWS, Azure, and GCP." },
  { id: "9", topic: "databases", content: "Databases store and organize data for retrieval. Core concepts include relational databases, SQL, NoSQL, indexing, ACID properties, transactions, normalization, joins, MongoDB, PostgreSQL, and caching with Redis." },
  { id: "10", topic: "devops", content: "DevOps bridges development and operations for faster delivery. Key concepts include CI/CD pipelines, Docker, Kubernetes, infrastructure as code, monitoring, logging, Git workflows, Jenkins, and site reliability engineering." },
];

async function uploadDocuments() {
  try {
    const response = await axios.post(
      `${process.env.AZURE_SEARCH_ENDPOINT}/indexes/${process.env.AZURE_SEARCH_INDEX}/docs/index?api-version=2023-11-01`,
      {
        value: documents.map((doc) => ({
          "@search.action": "mergeOrUpload",
          ...doc,
        })),
      },
      {
        headers: {
          "api-key": process.env.AZURE_SEARCH_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Documents uploaded:", response.data);
  } catch (err) {
    console.error("❌ Upload failed:", err.response?.data || err.message);
  }
}

uploadDocuments();