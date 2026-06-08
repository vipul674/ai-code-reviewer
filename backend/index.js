import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Octokit } from '@octokit/rest';
import { shouldIgnore } from './utils/reposageIgnore.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Ensure temp_repos folder exists
const tempReposDir = path.join(__dirname, 'temp_repos');
if (!fs.existsSync(tempReposDir)) {
  fs.mkdirSync(tempReposDir, { recursive: true });
}

// Global variable to cache the active repository context for chat functionality
let activeRepositoryContext = null;

// 🟢 Helper to recursively read files
function readFilesRecursively(dir, fileList = [], baseDir = dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    // Skip node_modules, git directories, and build artifacts
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'build') {
      continue;
    }

    // Check .reposageignore patterns
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
    if (shouldIgnore(relativePath, baseDir)) {
      continue;
    }

    if (stat.isDirectory()) {
      readFilesRecursively(filePath, fileList, baseDir);
    } else {
      // Analyze only source code files (Python, JS, TS, HTML, CSS, Go, Rust, Java, C++, PHP, Ruby, SQL)
      const ext = path.extname(file).toLowerCase();
      const validExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.h', '.cs', '.php', '.rb', '.sql', '.html', '.css'];
      
      if (validExtensions.includes(ext)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          fileList.push({
            name: path.relative(baseDir, filePath).replace(/\\/g, '/'),
            content: content
          });
        } catch (e) {
          console.warn(`Could not read file: ${filePath}`, e.message);
        }
      }
    }
  }
  return fileList;
}

// 🟢 Helper to scan for secrets/keys in code files
function scanSecrets(fileContent) {
  const findings = [];
  const rules = [
    {
      type: "AWS Access Key Check",
      regex: /AKIA[0-9A-Z]{16}/g,
      description: "Potential AWS Access Key ID detected. If pushed to a public repository, malicious parties can hijack your AWS cloud infrastructure."
    },
    {
      type: "GitHub Personal Access Token",
      regex: /ghp_[a-zA-Z0-9]{36}/g,
      description: "Hardcoded GitHub Personal Access Token detected. Unauthorized users can gain complete read/write access to your repositories."
    },
    {
      type: "Stripe Secret API Key",
      regex: /sk_live_[0-9a-zA-Z]{24}/g,
      description: "Hardcoded live Stripe Secret Key detected. This can expose customer transaction history or result in financial exploitation."
    },
    {
      type: "Google Cloud API Key",
      regex: /AIzaSy[a-zA-Z0-9-_]{33}/g,
      description: "Hardcoded Google Cloud API Key detected. Allows unauthorized usage of GCP billing services and resources."
    },
    {
      type: "Database Connection Credentials",
      regex: /(mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/)[a-zA-Z0-9_]+:[a-zA-Z0-9_]+@/gi,
      description: "Database connection credentials detected directly in code. Exposes the database tables to global read/write breaches."
    },
    {
      type: "Slack Incoming Webhook",
      regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8}\/B[A-Z0-9]{8}\/[A-Za-z0-9]{24}/g,
      description: "Hardcoded Slack Incoming Webhook detected. Allows external parties to send spam or phish users inside your workspace channels."
    },
    {
      type: "Generic Private Key",
      regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/gi,
      description: "Generic Private Key detected. Committing private keys to a repository exposes critical encryption keys, identity access, or infrastructure certificates."
    },
    {
      type: "Common Environment Credential",
      regex: /(?:password|passwd|secret|secret_key|private_key|api_key|token|auth_token)\s*=\s*['"][^'"]+['"]/gi,
      description: "Hardcoded credential (e.g. password, secret key, token) detected. Storing raw configurations in code commits is a major security risk."
    },
    {
      type: "Twilio Account SID",
      regex: /\bAC[a-f0-9]{32}\b/gi,
      description: "Potential Twilio Account SID detected. Exposing your Twilio SID allows unauthorized API access and billing charges."
    },
    {
      type: "Twilio Auth Token",
      regex: /(?:twilio_auth|twilio_token|auth_token)\s*[:=]\s*['"][a-f0-9]{32}['"]/gi,
      description: "Potential Twilio Auth Token detected. Exposing this token allows attackers to authenticate and use your Twilio account."
    }
  ];

  const lines = fileContent.split('\n');
  lines.forEach((line, idx) => {
    rules.forEach(rule => {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(line)) {
        findings.push({
          type: rule.type,
          line: idx + 1,
          description: rule.description,
          suggestion: "Move this secret immediately to a protected environment configuration file (.env) and reference it as a dynamic variable instead."
        });
      }
    });
  });

  return findings;
}

// 🟢 Helper to parse git diff for webhook changes
function parseDiff(diffStr) {
  const files = [];
  const lines = diffStr.split('\n');
  let currentFile = null;
  let currentLineInNewFile = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = {
          path: match[1],
          changes: []
        };
        files.push(currentFile);
      }
    } else if (line.startsWith('@@ ')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        currentLineInNewFile = parseInt(match[1], 10);
      }
    } else if (currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.changes.push({
          line: currentLineInNewFile,
          content: line.slice(1)
        });
        currentLineInNewFile++;
      } else if (line.startsWith(' ')) {
        currentLineInNewFile++;
      }
    }
  }
  return files;
}

// 🟢 Helper to scan changes for hardcoded secrets
function scanSecretsInChanges(changes) {
  const findings = [];
  const rules = [
    {
      type: "AWS Access Key Check",
      regex: /AKIA[0-9A-Z]{16}/g,
      description: "Potential AWS Access Key ID detected. If pushed to a public repository, malicious parties can hijack your AWS cloud infrastructure."
    },
    {
      type: "GitHub Personal Access Token",
      regex: /ghp_[a-zA-Z0-9]{36}/g,
      description: "Hardcoded GitHub Personal Access Token detected. Unauthorized users can gain complete read/write access to your repositories."
    },
    {
      type: "Stripe Secret API Key",
      regex: /sk_live_[0-9a-zA-Z]{24}/g,
      description: "Hardcoded live Stripe Secret Key detected. This can expose customer transaction history or result in financial exploitation."
    },
    {
      type: "Google Cloud API Key",
      regex: /AIzaSy[a-zA-Z0-9-_]{33}/g,
      description: "Hardcoded Google Cloud API Key detected. Allows unauthorized usage of GCP billing services and resources."
    },
    {
      type: "Database Connection Credentials",
      regex: /(mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/)[a-zA-Z0-9_]+:[a-zA-Z0-9_]+@/gi,
      description: "Database connection credentials detected directly in code. Exposes the database tables to global read/write breaches."
    },
    {
      type: "Slack Incoming Webhook",
      regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8}\/B[A-Z0-9]{8}\/[A-Za-z0-9]{24}/g,
      description: "Hardcoded Slack Incoming Webhook detected. Allows external parties to send spam or phish users inside your workspace channels."
    },
    {
      type: "Generic Private Key",
      regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/gi,
      description: "Generic Private Key detected. Committing private keys to a repository exposes critical encryption keys, identity access, or infrastructure certificates."
    },
    {
      type: "Common Environment Credential",
      regex: /(?:password|passwd|secret|secret_key|private_key|api_key|token|auth_token)\s*=\s*['"][^'"]+['"]/gi,
      description: "Hardcoded credential (e.g. password, secret key, token) detected. Storing raw configurations in code commits is a major security risk."
    },
    {
      type: "Twilio Account SID",
      regex: /\bAC[a-f0-9]{32}\b/gi,
      description: "Potential Twilio Account SID detected. Exposing your Twilio SID allows unauthorized API access and billing charges."
    },
    {
      type: "Twilio Auth Token",
      regex: /(?:twilio_auth|twilio_token|auth_token)\s*[:=]\s*['"][a-f0-9]{32}['"]/gi,
      description: "Potential Twilio Auth Token detected. Exposing this token allows attackers to authenticate and use your Twilio account."
    }
  ];

  for (const change of changes) {
    for (const rule of rules) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(change.content)) {
        findings.push({
          line: change.line,
          type: "security",
          comment: `### 🛡️ Hardcoded Secret Warning\n\nI have detected a hardcoded **${rule.type}** on line **${change.line}**.\n\n#### 💡 Actionable Suggestion\nMove this credential immediately to a protected environment variable (e.g. GitHub Secrets or \`.env\`) and load it dynamically at runtime. DO NOT commit plain secrets to public Git repositories!`
        });
      }
    }
  }

  return findings;
}

// 🟢 Helper to analyze static complexity of source files
function analyzeComplexity(fileContent, filePath) {
  const lines = fileContent.split('\n');
  const totalLines = lines.length;
  let emptyLines = 0;
  let commentLines = 0;
  let functionCount = 0;

  const ext = path.extname(filePath).toLowerCase();

  // Languages that use C-style block comments /* ... */
  const cStyleExts = ['.js', '.jsx', '.ts', '.tsx', '.java', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.css'];
  const usesCStyleBlocks = cStyleExts.includes(ext);
  const usesHtmlBlocks = (ext === '.html');
  let inBlockComment = false;

  lines.forEach(line => {
    const trimmed = line.trim();

    // Empty line detection
    if (trimmed === '') {
      emptyLines++;
      return;
    }

    // --- Comment Detection with multi-line block tracking ---

    if (usesCStyleBlocks) {
      // Currently inside a /* ... */ block comment
      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        return;
      }

      // Single-line comment: //
      if (trimmed.startsWith('//')) {
        commentLines++;
      }
      // Single-line block comment: /* ... */ on same line
      else if (trimmed.startsWith('/*') && trimmed.includes('*/')) {
        commentLines++;
      }
      // Multi-line block comment opening: /*
      else if (trimmed.startsWith('/*')) {
        commentLines++;
        inBlockComment = true;
      }
      // Line starting with * inside a doc-comment block (e.g. JSDoc)
      else if (trimmed.startsWith('*')) {
        commentLines++;
      }
    } else if (ext === '.py' || ext === '.rb') {
      if (trimmed.startsWith('#')) {
        commentLines++;
      }
    } else if (ext === '.sql') {
      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        return;
      }
      if (trimmed.startsWith('--')) {
        commentLines++;
      } else if (trimmed.startsWith('/*') && trimmed.includes('*/')) {
        commentLines++;
      } else if (trimmed.startsWith('/*')) {
        commentLines++;
        inBlockComment = true;
      }
    } else if (usesHtmlBlocks) {
      if (trimmed.startsWith('<!--')) {
        commentLines++;
      }
    }

    // --- Function Detection ---
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
      if (trimmed.includes('function ') || trimmed.includes('=>') || /^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{/g.test(trimmed)) {
        functionCount++;
      }
    } else if (ext === '.py') {
      if (trimmed.startsWith('def ')) {
        functionCount++;
      }
    } else if (ext === '.go') {
      if (trimmed.startsWith('func ')) {
        functionCount++;
      }
    } else if (['.java', '.cpp', '.cs'].includes(ext)) {
      if (/(?:public|private|protected|static|\w+)\s+\w+\s*\([^)]*\)\s*(?:\{|const)?/g.test(trimmed)) {
        functionCount++;
      }
    }
  });

  const codeLines = totalLines - emptyLines - commentLines;
  const complexityScore = Math.round((totalLines / 25) + (functionCount * 3));
  let grade = 'A';
  if (complexityScore > 40) grade = 'F';
  else if (complexityScore > 25) grade = 'D';
  else if (complexityScore > 15) grade = 'C';
  else if (complexityScore > 8) grade = 'B';

  return {
    totalLines,
    emptyLines,
    commentLines,
    codeLines,
    functionCount,
    complexityScore,
    grade
  };
}

// 🟢 Helper to delete a folder recursively
function deleteFolderRecursive(directoryPath) {
  if (fs.existsSync(directoryPath)) {
    fs.readdirSync(directoryPath).forEach((file) => {
      const curPath = path.join(directoryPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(directoryPath);
  }
}

// 🟢 Route: GitHub Import & AI Review
app.post('/api/analyze', async (req, res) => {
  const { repoUrl, company = 'General', language = 'English', model = 'llama-3.3-70b-versatile' } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: 'GitHub Repository URL is required.' });
  }

  // Generate unique folder name
  const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'temp';
  const uniqueId = Date.now();
  const clonePath = path.join(tempReposDir, `${repoName}_${uniqueId}`);

  console.log(`🚀 Cloning: ${repoUrl} into ${clonePath}`);

  // Clone repo
  exec(`git clone --depth 1 ${repoUrl} "${clonePath}"`, async (error) => {
    if (error) {
      console.error(`❌ Git Clone Error: ${error.message}`);
      return res.status(500).json({ error: 'Failed to clone repository. Make sure the URL is public.' });
    }

    try {
      // 1. Read files
      const files = readFilesRecursively(clonePath);
      
      if (files.length === 0) {
        deleteFolderRecursive(clonePath);
        return res.status(400).json({ error: 'No supportable source code files found in the repository.' });
      }

      console.log(`📁 Found ${files.length} valid source files. Sending to AI engine...`);

      // 2. Mocking AI Response for initial setup (or forward to FastAPI AI Engine)
      // This is a perfect placeholder where contributors can connect the FastAPI server!
      const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://localhost:8000';
      
      let reviewResult;
      try {
        const aiResponse = await fetch(`${aiEngineUrl}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, company, language, model })
        });
        
        if (aiResponse.ok) {
          reviewResult = await aiResponse.json();
        } else {
          throw new Error('AI engine responded with error');
        }
      } catch (err) {
        console.warn('⚠️ FastAPI engine not running, falling back to local Express review handler');
        // Let's generate a smart mockup review based on files so it works as an autonomous MVP
        reviewResult = mockAIReview(files, model);
      }

      // 3. Inject Regex-based Secret Detections & Complexity Metrics into the analysis result
      if (reviewResult && reviewResult.fileReviews) {
        reviewResult.metrics = {};
        
        files.forEach(file => {
          // Calculate complexity metrics
          reviewResult.metrics[file.name] = analyzeComplexity(file.content, file.name);

          const secretFindings = scanSecrets(file.content);
          if (secretFindings.length > 0) {
            // Make sure the file exists in reviews
            if (!reviewResult.fileReviews[file.name]) {
              reviewResult.fileReviews[file.name] = { bugs: [], security: [], optimization: [], styling: [] };
            }
            // Append found secrets to security category
            if (!reviewResult.fileReviews[file.name].security) {
              reviewResult.fileReviews[file.name].security = [];
            }
            // Avoid duplicate additions
            secretFindings.forEach(finding => {
              const duplicate = reviewResult.fileReviews[file.name].security.some(s => s.line === finding.line && s.type === finding.type);
              if (!duplicate) {
                reviewResult.fileReviews[file.name].security.unshift(finding); // Place at top of security findings
              }
            });
          }
        });
      }

      // 3. Cache the active repository context for chat
      activeRepositoryContext = {
        repoUrl,
        repoName,
        files
      };

      // 4. Clean up folder
      deleteFolderRecursive(clonePath);
      
      // 5. Return result
      return res.json({
        success: true,
        repoName,
        filesReviewedCount: files.length,
        analysis: reviewResult
      });

    } catch (err) {
      console.error(err);
      deleteFolderRecursive(clonePath);
      return res.status(500).json({ error: 'An error occurred during repository analysis.' });
    }
  });
});

// 🟢 Route: AI Chat with Repository
app.post('/api/chat', async (req, res) => {
  const { message, history = [], model = 'llama-3.3-70b-versatile' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (!activeRepositoryContext) {
    return res.status(400).json({ error: 'No repository is currently active. Please analyze a repository first.' });
  }

  const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://localhost:8000';

  try {
    const aiResponse = await fetch(`${aiEngineUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: activeRepositoryContext.files,
        message,
        history,
        model
      })
    });

    if (aiResponse.ok) {
      const data = await aiResponse.json();
      return res.json(data);
    } else {
      const errText = await aiResponse.text();
      throw new Error(errText || 'AI engine chat request failed');
    }
  } catch (err) {
    console.error('❌ Chat API Error:', err.message);
    
    // Simple local fallback if Python FastAPI server is offline
    const responseMessage = `[Fallback Response] I see you are asking about: "${message}". Currently, the FastAPI AI Engine is offline, so I cannot analyze the full codebase for your query. Please make sure the AI Engine service is running on port 8000.`;
    return res.json({ response: responseMessage });
  }
});

// 🟢 Helper to generate mock AI review based on files
function mockAIReview(files, model) {
  const fileReviews = {};
  
  files.forEach(file => {
    const complexity = analyzeComplexity(file.content, file.name);
    const securityFindings = scanSecrets(file.content);
    const bugs = [];
    const security = securityFindings;
    const optimizations = [];
    const styling = [];

    // Simple regex-based bug detection
    const lines = file.content.split('\n');
    lines.forEach((line, idx) => {
      // Check for console.log in production
      if (line.includes('console.log') || line.includes('console.warn')) {
        bugs.push({
          line: idx + 1,
          type: "bug",
          comment: `### 🐛 Debug Statement Detected\n\nI detected a \`console.${line.includes('console.warn') ? 'warn' : 'log'}\` statement on line **${idx + 1}**.\n\n#### 💡 Actionable Suggestion\nRemove or replace debug statements before deploying to production.`
        });
      }

      // Check for any/any in TypeScript
      if (line.includes(': any') && (file.name.endsWith('.ts') || file.name.endsWith('.tsx'))) {
        optimizations.push({
          line: idx + 1,
          type: "optimization",
          comment: `### ⚡ Avoid Using 'any' Type\n\nI detected an \`any\` type on line **${idx + 1}**.\n\n#### 💡 Actionable Suggestion\nUse a more specific type to improve type safety.`
        });
      }

      // Check for TODO comments
      if (/TODO|FIXME|HACK|XXX/i.test(line)) {
        styling.push({
          line: idx + 1,
          type: "styling",
          comment: `### 📝 TODO/FIXME Comment Found\n\nI detected a TODO or FIXME comment on line **${idx + 1}**.\n\n#### 💡 Actionable Suggestion\nAddress this before considering the code production-ready.`
        });
      }

      // Long lines
      if (line.length > 120) {
        styling.push({
          line: idx + 1,
          type: "styling",
          comment: `### 📏 Long Line Detected\n\nLine **${idx + 1}** exceeds 120 characters (current: ${line.length}).\n\n#### 💡 Actionable Suggestion\nConsider breaking this line into multiple lines for readability.`
        });
      }
    });

    // Check for hardcoded secrets
    if (securityFindings.length > 0) {
      optimizations.push({
        type: "optimization",
        comment: `### 🔒 Security Priority\n\nThis file contains **${securityFindings.length}** security finding(s). Please prioritize resolving these before deploying.`
      });
    }

    fileReviews[file.name] = {
      bugs,
      security,
      optimizations,
      styling
    };
  });

  return {
    fileReviews,
    summary: {
      totalFiles: files.length,
      totalBugs: Object.values(fileReviews).reduce((sum, r) => sum + r.bugs.length, 0),
      totalSecurity: Object.values(fileReviews).reduce((sum, r) => sum + r.security.length, 0),
      totalOptimizations: Object.values(fileReviews).reduce((sum, r) => sum + r.optimizations.length, 0),
      totalStyling: Object.values(fileReviews).reduce((sum, r) => sum + r.styling.length, 0)
    }
  };
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});