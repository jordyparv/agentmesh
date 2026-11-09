"use client";
import Link from "next/link";
import { TaskStatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, ErrorState, Loading } from "@/components/ui/states";
import { Table, Td, Th } from "@/components/ui/table";
import { useApi } from "@/lib/hooks";
import type { Task } from "@/lib/types";
import { shortSha, timeAgo } from "@/lib/utils";

export default function ReviewQueue() {
  // All accessible projects: the queue is global so nothing waits unseen.
  const { data, error, isLoading } = useApi<(Task & { projectName: string; agentName: string | null })[]>("/reviews", { refreshInterval: 5000 });
  return (
    <>
      <PageHeader title="Review Center" description="Validated work awaiting a human decision. Nothing reaches a default branch without passing through here." />
      {error ? <ErrorState error={error} /> : null}
      {isLoading ? <Loading /> : null}
      {data ? (
        <Card>
          {data.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Task</Th>
                  <Th>Project</Th>
                  <Th>Agent</Th>
                  <Th>Status</Th>
                  <Th>Head</Th>
                  <Th>Changed</Th>
                  <Th>Waiting</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((t) => {
                  const files = ((t.result as { changedFiles?: unknown[] } | null)?.changedFiles ?? []).length;
                  return (
                    <tr key={t.id} className="hover:bg-accent/50">
                      <Td>
                        <Link href={`/reviews/${t.id}`} className="font-medium hover:underline">
                          {t.title}
                        </Link>
                      </Td>
                      <Td>{t.projectName}</Td>
                      <Td>{t.agentName ?? "—"}</Td>
                      <Td>
                        <TaskStatusBadge status={t.status} />
                      </Td>
                      <Td className="font-mono text-xs">{shortSha(t.headSha)}</Td>
                      <Td>
                        <Badge>{files} files</Badge>
                      </Td>
                      <Td className="text-muted-foreground">{timeAgo(t.updatedAt)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <Empty title="Review queue is empty">Code-modifying tasks land here once their quality gates pass.</Empty>
          )}
        </Card>
      ) : null}
    </>
  );
}
