/**
 * Knowledge Base Engine
 *
 * Companies need their agent to know their products, docs, FAQs,
 * internal processes. This engine handles:
 * - Document ingestion (PDF, markdown, HTML, text, CSV)
 * - Chunking and embedding
 * - Semantic search / retrieval (RAG)
 * - Knowledge base CRUD per agent
 *
 * The agent queries this before answering customer questions.
 */

// ─── Types ──────────────────────────────────────────────

export interface KnowledgeBase {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  agentIds: string[];                // Which agents can access this KB
  documents: KBDocument[];
  stats: {
    totalDocuments: number;
    totalChunks: number;
    totalTokens: number;
    lastUpdated: string;
  };
  config: KBConfig;
  createdAt: string;
  updatedAt: string;
}

export interface KBDocument {
  id: string;
  knowledgeBaseId: string;
  name: string;
  sourceType: 'file' | 'url' | 'text' | 'api';
  sourceUrl?: string;
  mimeType: string;
  size: number;                      // Bytes
  chunks: KBChunk[];
  metadata: Record<string, any>;
  status: 'processing' | 'ready' | 'error';
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KBChunk {
  id: string;
  documentId: string;
  content: string;
  tokenCount: number;
  position: number;                  // Order within document
  embedding?: number[];              // Vector embedding
  metadata: {
    section?: string;                // Document section/heading
    page?: number;
    lineStart?: number;
    lineEnd?: number;
  };
}

export interface KBConfig {
  chunkSize: number;                 // Target tokens per chunk (default: 512)
  chunkOverlap: number;             // Overlap tokens between chunks (default: 50)
  embeddingModel: string;           // e.g. "text-embedding-3-small"
  embeddingProvider: 'openai' | 'local' | 'none';
  maxResultsPerQuery: number;       // Default: 5
  minSimilarityScore: number;       // Default: 0.7
  autoRefreshUrls: boolean;         // Re-fetch URL sources periodically
  refreshIntervalHours: number;     // Default: 24
}

export interface SearchResult {
  chunk: KBChunk;
  document: KBDocument;
  score: number;                    // Similarity score 0-1
  highlight?: string;               // Relevant excerpt with match highlighted
}

// ─── Knowledge Base Engine ──────────────────────────────

export class KnowledgeBaseEngine {
  private knowledgeBases = new Map<string, KnowledgeBase>();
  private embeddings = new Map<string, number[]>();  // chunkId → embedding

  /**
   * Create a new knowledge base
   */
  createKnowledgeBase(orgId: string, opts: {
    name: string;
    description?: string;
    agentIds?: string[];
    config?: Partial<KBConfig>;
  }): KnowledgeBase {
    const kb: KnowledgeBase = {
      id: crypto.randomUUID(),
      orgId,
      name: opts.name,
      description: opts.description,
      agentIds: opts.agentIds || [],
      documents: [],
      stats: { totalDocuments: 0, totalChunks: 0, totalTokens: 0, lastUpdated: new Date().toISOString() },
      config: {
        chunkSize: 512,
        chunkOverlap: 50,
        embeddingModel: 'text-embedding-3-small',
        embeddingProvider: 'openai',
        maxResultsPerQuery: 5,
        minSimilarityScore: 0.7,
        autoRefreshUrls: false,
        refreshIntervalHours: 24,
        ...opts.config,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.knowledgeBases.set(kb.id, kb);
    return kb;
  }

  /**
   * Ingest a document into a knowledge base
   */
  async ingestDocument(kbId: string, opts: {
    name: string;
    content: string;
    sourceType: KBDocument['sourceType'];
    sourceUrl?: string;
    mimeType?: string;
    metadata?: Record<string, any>;
  }): Promise<KBDocument> {
    const kb = this.knowledgeBases.get(kbId);
    if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

    const doc: KBDocument = {
      id: crypto.randomUUID(),
      knowledgeBaseId: kbId,
      name: opts.name,
      sourceType: opts.sourceType,
      sourceUrl: opts.sourceUrl,
      mimeType: opts.mimeType || 'text/plain',
      size: Buffer.byteLength(opts.content, 'utf-8'),
      chunks: [],
      metadata: opts.metadata || {},
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      // Extract text based on format
      const text = this.extractText(opts.content, doc.mimeType);

      // Chunk the text
      const chunks = this.chunkText(text, doc.id, kb.config);
      doc.chunks = chunks;

      // Generate embeddings
      if (kb.config.embeddingProvider !== 'none') {
        await this.generateEmbeddings(chunks, kb.config);
      }

      doc.status = 'ready';

      // Update KB stats
      kb.documents.push(doc);
      kb.stats.totalDocuments = kb.documents.length;
      kb.stats.totalChunks = kb.documents.reduce((sum, d) => sum + d.chunks.length, 0);
      kb.stats.totalTokens = kb.documents.reduce((sum, d) =>
        sum + d.chunks.reduce((cs, c) => cs + c.tokenCount, 0), 0);
      kb.stats.lastUpdated = new Date().toISOString();
      kb.updatedAt = new Date().toISOString();

    } catch (error: any) {
      doc.status = 'error';
      doc.error = error.message;
    }

    return doc;
  }

  /**
   * Search across knowledge bases for an agent
   */
  async search(agentId: string, query: string, opts?: {
    kbIds?: string[];
    maxResults?: number;
    minScore?: number;
  }): Promise<SearchResult[]> {
    // Find all KBs this agent has access to
    const kbs = Array.from(this.knowledgeBases.values()).filter(kb => {
      if (opts?.kbIds?.length) return opts.kbIds.includes(kb.id);
      return kb.agentIds.includes(agentId) || kb.agentIds.length === 0; // Empty = all agents
    });

    if (kbs.length === 0) return [];

    const maxResults = opts?.maxResults || 5;
    const minScore = opts?.minScore || 0.7;

    // Get query embedding
    const queryEmbedding = await this.getEmbedding(query, kbs[0].config);

    // Search all chunks across all accessible KBs
    const results: SearchResult[] = [];

    for (const kb of kbs) {
      for (const doc of kb.documents) {
        if (doc.status !== 'ready') continue;

        for (const chunk of doc.chunks) {
          let score: number;

          if (queryEmbedding && chunk.embedding) {
            // Vector similarity search
            score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
          } else {
            // Fallback: keyword matching
            score = this.keywordScore(query, chunk.content);
          }

          if (score >= minScore) {
            results.push({
              chunk,
              document: doc,
              score,
              highlight: this.extractHighlight(query, chunk.content),
            });
          }
        }
      }
    }

    // Sort by score, return top N
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Generate context string for an agent's prompt (RAG injection)
   */
  async getContext(agentId: string, query: string, maxTokens: number = 2000): Promise<string> {
    const results = await this.search(agentId, query);
    if (results.length === 0) return '';

    let context = '## Relevant Knowledge Base Context\n\n';
    let tokenCount = 0;

    for (const result of results) {
      const chunkTokens = result.chunk.tokenCount;
      if (tokenCount + chunkTokens > maxTokens) break;

      context += `### From: ${result.document.name}`;
      if (result.chunk.metadata.section) context += ` > ${result.chunk.metadata.section}`;
      context += `\n${result.chunk.content}\n\n`;
      tokenCount += chunkTokens;
    }

    return context;
  }

  // ─── CRUD ───────────────────────────────────────────

  getKnowledgeBase(id: string): KnowledgeBase | undefined {
    return this.knowledgeBases.get(id);
  }

  getKnowledgeBasesByOrg(orgId: string): KnowledgeBase[] {
    return Array.from(this.knowledgeBases.values()).filter(kb => kb.orgId === orgId);
  }

  getKnowledgeBasesForAgent(agentId: string): KnowledgeBase[] {
    return Array.from(this.knowledgeBases.values()).filter(kb =>
      kb.agentIds.includes(agentId) || kb.agentIds.length === 0
    );
  }

  deleteDocument(kbId: string, docId: string): boolean {
    const kb = this.knowledgeBases.get(kbId);
    if (!kb) return false;
    const idx = kb.documents.findIndex(d => d.id === docId);
    if (idx < 0) return false;

    // Remove embeddings for chunks
    for (const chunk of kb.documents[idx].chunks) {
      this.embeddings.delete(chunk.id);
    }

    kb.documents.splice(idx, 1);
    kb.stats.totalDocuments = kb.documents.length;
    kb.stats.totalChunks = kb.documents.reduce((sum, d) => sum + d.chunks.length, 0);
    kb.updatedAt = new Date().toISOString();
    return true;
  }

  deleteKnowledgeBase(id: string): boolean {
    return this.knowledgeBases.delete(id);
  }

  // ─── Text Processing ─────────────────────────────────

  private extractText(content: string, mimeType: string): string {
    // For now, handle plain text and markdown directly
    // PDF, DOCX, etc. would need additional parsers
    switch (mimeType) {
      case 'text/html':
        // Strip HTML tags
        return content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      case 'text/csv':
        // Convert CSV rows to readable text
        return content.split('\n').map(row => row.replace(/,/g, ' | ')).join('\n');
      default:
        return content;
    }
  }

  private chunkText(text: string, documentId: string, config: KBConfig): KBChunk[] {
    const chunks: KBChunk[] = [];
    const sentences = this.splitIntoSentences(text);
    let currentChunk = '';
    let currentTokens = 0;
    let position = 0;
    let currentSection: string | undefined;

    for (const sentence of sentences) {
      // Detect section headings
      const headingMatch = sentence.match(/^#+\s+(.+)$/);
      if (headingMatch) {
        currentSection = headingMatch[1];
      }

      const sentenceTokens = this.estimateTokens(sentence);

      if (currentTokens + sentenceTokens > config.chunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          id: crypto.randomUUID(),
          documentId,
          content: currentChunk.trim(),
          tokenCount: currentTokens,
          position: position++,
          metadata: { section: currentSection },
        });

        // Start new chunk with overlap
        const overlapText = this.getOverlapText(currentChunk, config.chunkOverlap);
        currentChunk = overlapText + ' ' + sentence;
        currentTokens = this.estimateTokens(currentChunk);
      } else {
        currentChunk += ' ' + sentence;
        currentTokens += sentenceTokens;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim().length > 0) {
      chunks.push({
        id: crypto.randomUUID(),
        documentId,
        content: currentChunk.trim(),
        tokenCount: currentTokens,
        position: position,
        metadata: { section: currentSection },
      });
    }

    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    // Split on sentence boundaries, keeping headings together
    return text.split(/(?<=[.!?])\s+|(?=^#+\s)/m).filter(s => s.trim().length > 0);
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }

  private getOverlapText(text: string, overlapTokens: number): string {
    const words = text.split(/\s+/);
    const overlapWords = Math.ceil(overlapTokens * 0.75); // ~0.75 words per token
    return words.slice(-overlapWords).join(' ');
  }

  // ─── Embeddings ─────────────────────────────────────

  private async generateEmbeddings(chunks: KBChunk[], config: KBConfig) {
    if (config.embeddingProvider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return; // Skip if no API key

      // Batch embeddings (OpenAI supports up to 2048 inputs)
      const batchSize = 100;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        try {
          const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: config.embeddingModel,
              input: batch.map(c => c.content),
            }),
          });

          if (response.ok) {
            const data = await response.json() as any;
            for (let j = 0; j < data.data.length; j++) {
              batch[j].embedding = data.data[j].embedding;
              this.embeddings.set(batch[j].id, data.data[j].embedding);
            }
          }
        } catch { /* skip embedding on error */ }
      }
    }
  }

  private async getEmbedding(text: string, config: KBConfig): Promise<number[] | null> {
    if (config.embeddingProvider !== 'openai') return null;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: config.embeddingModel, input: text }),
      });
      if (response.ok) {
        const data = await response.json() as any;
        return data.data[0].embedding;
      }
    } catch { /* fall through */ }

    return null;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private keywordScore(query: string, content: string): number {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const contentLower = content.toLowerCase();
    let matches = 0;
    for (const word of queryWords) {
      if (contentLower.includes(word)) matches++;
    }
    return queryWords.length > 0 ? matches / queryWords.length : 0;
  }

  private extractHighlight(query: string, content: string, maxLength: number = 200): string {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

    // Find sentence with most keyword matches
    let bestSentence = sentences[0] || content.slice(0, maxLength);
    let bestScore = 0;

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const score = queryWords.filter(w => lower.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence;
      }
    }

    return bestSentence.trim().slice(0, maxLength) + (bestSentence.length > maxLength ? '...' : '');
  }
}
