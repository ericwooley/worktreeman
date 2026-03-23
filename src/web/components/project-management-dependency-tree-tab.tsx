import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Connection, Edge, Node, OnEdgesChange, OnNodesChange, ReactFlowInstance } from "@xyflow/react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary } from "@shared/types";
import { MatrixBadge } from "./matrix-primitives";

type DependencyTreeDocument = Pick<
  ProjectManagementDocumentSummary,
  "id" | "number" | "title" | "status" | "assignee" | "archived" | "dependencies"
>;

interface ProjectManagementDependencyTreeTabProps {
  documents: ProjectManagementDocumentSummary[];
  selectedDocumentId: string | null;
  saving: boolean;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onUpdateDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocument | null>;
}

function normalizeDependencyTreeDocuments(documents: ProjectManagementDocumentSummary[]): DependencyTreeDocument[] {
  return documents.map((document) => ({
    ...document,
    dependencies: Array.isArray(document.dependencies) ? document.dependencies : [],
  }));
}

function buildLevels(documents: DependencyTreeDocument[]): Map<string, number> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const visiting = new Set<string>();
  const memo = new Map<string, number>();

  function visit(documentId: string): number {
    if (memo.has(documentId)) {
      return memo.get(documentId)!;
    }

    if (visiting.has(documentId)) {
      return 0;
    }

    visiting.add(documentId);
    const document = byId.get(documentId);
    const level = document && document.dependencies.length
      ? 1 + Math.max(...document.dependencies.map((dependencyId) => visit(dependencyId)))
      : 0;
    visiting.delete(documentId);
    memo.set(documentId, level);
    return level;
  }

  for (const document of documents) {
    visit(document.id);
  }

  return memo;
}

function buildLayout(documents: DependencyTreeDocument[], selectedDocumentId: string | null) {
  const levels = buildLevels(documents);
  const buckets = new Map<number, DependencyTreeDocument[]>();

  for (const document of documents) {
    const level = levels.get(document.id) ?? 0;
    const bucket = buckets.get(level) ?? [];
    bucket.push(document);
    buckets.set(level, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => left.number - right.number);
  }

  return documents.map<Node>((document) => {
    const level = levels.get(document.id) ?? 0;
    const row = buckets.get(level)?.findIndex((entry) => entry.id === document.id) ?? 0;

    return {
      id: document.id,
      position: {
        x: level * 320,
        y: row * 140,
      },
      data: {
        ...document,
        label: `#${document.number} ${document.title}`,
      },
      className: document.id === selectedDocumentId ? "pm-dependency-node pm-dependency-node-selected" : "pm-dependency-node",
      draggable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      type: "default",
    };
  });
}

function buildEdges(documents: DependencyTreeDocument[]): Edge[] {
  const knownIds = new Set(documents.map((document) => document.id));

  return documents.flatMap((document) =>
    document.dependencies
      .filter((dependencyId) => knownIds.has(dependencyId))
      .map((dependencyId) => ({
        id: `${dependencyId}->${document.id}`,
        source: dependencyId,
        target: document.id,
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
        label: "depends on",
        labelStyle: {
          fontSize: 11,
          fontWeight: 600,
        },
      })),
  );
}

function hasPath(graph: Map<string, string[]>, startId: string, targetId: string): boolean {
  const stack = [startId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === targetId) {
      return true;
    }
    if (seen.has(currentId)) {
      continue;
    }
    seen.add(currentId);
    for (const nextId of graph.get(currentId) ?? []) {
      if (!seen.has(nextId)) {
        stack.push(nextId);
      }
    }
  }

  return false;
}

function wouldCreateCycle(documents: DependencyTreeDocument[], dependencyId: string, dependentId: string): boolean {
  const graph = new Map(documents.map((document) => [document.id, [...document.dependencies]]));
  graph.set(dependentId, [...(graph.get(dependentId) ?? []), dependencyId]);
  return hasPath(graph, dependencyId, dependentId);
}

function getDependencyError(documents: DependencyTreeDocument[], dependencyId: string, dependentId: string): string | null {
  if (dependencyId === dependentId) {
    return "A document cannot depend on itself.";
  }

  if (wouldCreateCycle(documents, dependencyId, dependentId)) {
    return "Dependency cycles are not allowed.";
  }

  return null;
}

function openDependencyDocumentInNewTab(documentId: string) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("tab", "project-management");
  nextUrl.searchParams.set("pmTab", "document");
  nextUrl.searchParams.set("pmDoc", documentId);
  window.open(nextUrl.toString(), "_blank", "noopener,noreferrer");
}

export function ProjectManagementDependencyTreeTab({
  documents,
  selectedDocumentId,
  saving,
  onSelectDocument,
  onUpdateDependencies,
}: ProjectManagementDependencyTreeTabProps) {
  const sortedDocuments = useMemo(
    () => normalizeDependencyTreeDocuments(documents).sort((left, right) => left.number - right.number),
    [documents],
  );
  const [nodes, setNodes] = useState<Node[]>(() => buildLayout(sortedDocuments, selectedDocumentId));
  const [edges, setEdges] = useState<Edge[]>(() => buildEdges(sortedDocuments));
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null);

  useEffect(() => {
    setNodes(buildLayout(sortedDocuments, selectedDocumentId));
    setEdges(buildEdges(sortedDocuments));
  }, [selectedDocumentId, sortedDocuments]);

  useEffect(() => {
    if (!reactFlowInstance || !selectedDocumentId) {
      return;
    }

    const selectedNode = nodes.find((node) => node.id === selectedDocumentId);
    if (!selectedNode) {
      return;
    }

    const timer = window.setTimeout(() => {
      reactFlowInstance.fitView({
        nodes: [{ id: selectedNode.id }],
        duration: 300,
        padding: 0.6,
        maxZoom: 1.2,
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [nodes, reactFlowInstance, selectedDocumentId]);

  const onNodesChange = useCallback<OnNodesChange>((changes) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback<OnEdgesChange>((changes) => {
    const removedEdges = changes
      .filter((change) => change.type === "remove")
      .map((change) => currentEdgeFromId(edges, change.id));

    setEdges((current) => applyEdgeChanges(changes, current));

    for (const edge of removedEdges) {
      if (!edge) {
        continue;
      }

      const targetDocument = sortedDocuments.find((document) => document.id === edge.target);
      if (!targetDocument) {
        continue;
      }

      const nextDependencies = targetDocument.dependencies.filter((dependencyId) => dependencyId !== edge.source);
      void onUpdateDependencies(targetDocument.id, nextDependencies);
    }
  }, [edges, onUpdateDependencies, sortedDocuments]);

  const onConnect = useCallback(async (connection: Connection) => {
    const dependencyId = connection.source;
    const dependentId = connection.target;
    if (!dependencyId || !dependentId) {
      return;
    }

    const dependentDocument = sortedDocuments.find((document) => document.id === dependentId);
    if (!dependentDocument) {
      return;
    }

    const dependencyError = getDependencyError(sortedDocuments, dependencyId, dependentId);
    if (dependencyError) {
      setError(dependencyError);
      return;
    }

    setError(null);
    const nextDependencies = Array.from(new Set([...dependentDocument.dependencies, dependencyId]));
    const response = await onUpdateDependencies(dependentId, nextDependencies);
    if (!response) {
      return;
    }

    setEdges((current) => addEdge({ ...connection, id: `${dependencyId}->${dependentId}` }, current));
  }, [onUpdateDependencies, sortedDocuments]);

  const sweepGraph = useCallback(() => {
    setNodes(buildLayout(sortedDocuments, selectedDocumentId));
    setError(null);
    reactFlowInstance?.fitView({ duration: 300, padding: 0.5, maxZoom: 1.1 });
  }, [reactFlowInstance, selectedDocumentId, sortedDocuments]);

  return (
    <div className="space-y-4">
      <div className="border theme-border-subtle p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="matrix-kicker">Dependency tree</p>
            <h3 className="mt-2 text-xl font-semibold theme-text-strong">Plan work relationships</h3>
            <p className="mt-2 text-sm theme-text-muted">
              Draw arrows from a prerequisite document to the document that depends on it. Cycles are blocked.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs theme-text-muted">
              <span className="pm-dependency-legend-node">Prerequisite</span>
              <span className="pm-dependency-legend-arrow" aria-hidden="true">-&gt;</span>
              <span className="pm-dependency-legend-node">Dependent</span>
              <span className="theme-text-soft">Target document depends on the source document.</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <MatrixBadge tone="neutral">{sortedDocuments.length} documents</MatrixBadge>
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              disabled={saving}
              onClick={sweepGraph}
            >
              Sweep
            </button>
          </div>
        </div>
        {error ? <div className="mt-3 border theme-border-danger theme-surface-danger px-3 py-2 text-sm theme-text-danger">{error}</div> : null}
      </div>

      <div ref={containerRef} className="border theme-border-subtle theme-surface-soft h-[70vh] overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => void onConnect(connection)}
            onNodeClick={(_, node) => {
              void onSelectDocument(node.id, { silent: true });
              openDependencyDocumentInNewTab(node.id);
            }}
            onInit={setReactFlowInstance}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
      </div>
    </div>
  );
}

function currentEdgeFromId(edges: Edge[], edgeId: string) {
  return edges.find((edge) => edge.id === edgeId) ?? null;
}
