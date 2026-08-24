import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/**
 * Follow up an asynchronous operation. `reindex` returns a task id and finishes
 * later, so without this a caller has no way to learn whether the copy
 * completed, how far it got, or why it failed.
 */
export async function getTask(
  esClient: Client,
  taskId: string
): Promise<ToolResult> {
  try {
    const response = await esClient.tasks.get<estypes.TasksGetResponse>({
      task_id: taskId,
    });

    const { completed, task, error } = response.body;
    const content: ToolResult["content"] = [
      textFragment(
        `Task ${taskId}: ${completed ? "completed" : "still running"}`
      ),
    ];

    if (task) {
      const seconds = Math.round(
        Number(task.running_time_in_nanos ?? 0) / 1_000_000_000
      );
      content.push(
        textFragment(
          `Action: ${task.action}\nRunning for: ${seconds}s\nCancellable: ${task.cancellable}`
        )
      );

      // For a reindex this carries created/updated/total — the progress a
      // caller actually wants.
      if (task.status) {
        content.push(
          textFragment(`Status: ${JSON.stringify(task.status, null, 2)}`)
        );
      }
    }

    if (error) {
      content.push(
        textFragment(`The task failed: ${JSON.stringify(error, null, 2)}`)
      );
    }

    return { content };
  } catch (error) {
    return toolError("Get task failed", error);
  }
}

/**
 * Every task the cluster is running. Diagnostic rather than follow-up: this is
 * how a long-running search or a stuck reindex nobody kept the id of gets found.
 */
export async function listTasks(
  esClient: Client,
  actions?: string
): Promise<ToolResult> {
  try {
    const response = await esClient.tasks.list<estypes.TasksListResponse>({
      detailed: true,
      ...(actions ? { actions } : {}),
    });

    const nodes = response.body.nodes ?? {};
    const rows: string[] = [];

    for (const [nodeId, node] of Object.entries(nodes)) {
      const nodeName = node.name ?? nodeId;
      for (const [taskId, task] of Object.entries(node.tasks ?? {})) {
        const seconds = Math.round(
          Number(task.running_time_in_nanos ?? 0) / 1_000_000_000
        );
        rows.push(
          `${taskId} on ${nodeName}: ${task.action} (${seconds}s${
            task.cancellable ? ", cancellable" : ""
          })`
        );
      }
    }

    if (rows.length === 0) {
      return {
        content: [
          textFragment(
            actions
              ? `No task running for actions matching "${actions}".`
              : "No task running."
          ),
        ],
      };
    }

    return {
      content: [
        textFragment(`${rows.length} tasks running`),
        textFragment(rows.join("\n")),
      ],
    };
  } catch (error) {
    return toolError("List tasks failed", error);
  }
}
