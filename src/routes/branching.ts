/**
 * Branching Routes
 * Trigger auto-branching after main line is completed
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { queues, QUEUE_NAMES, BranchingJobData } from '../lib/queue.js';
import { parseJsonField } from '../lib/json-utils.js';
import { Node as JsonNode } from '../schemas/node.js';

const StartBranchingSchema = z.object({
  model: z.string().optional(),
});

export async function branchingRoutes(app: FastifyInstance): Promise<void> {
  // Start auto-branching job
  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/branch',
    async (request, reply) => {
      const { id } = request.params;
      const body = StartBranchingSchema.parse(request.body ?? {});

      const session = await prisma.session.findUnique({
        where: { id },
        select: { status: true, nodes: true },
      });

      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      if (session.status !== 'completed') {
        return reply.status(400).send({ error: 'Session must be completed before branching' });
      }

      const nodes = parseJsonField<Record<string, JsonNode>>(session.nodes, {});
      const completedMain = Object.values(nodes).filter(
        (n: any) => n.status === 'completed' && !!n.content,
      );

      if (completedMain.length === 0) {
        return reply.status(400).send({ error: 'No completed nodes available for branching' });
      }

      // Create task record
      const task = await prisma.task.create({
        data: {
          sessionId: id,
          type: 'branching',
          status: 'pending',
          total: 5,
        },
      });

      const jobData: BranchingJobData = {
        sessionId: id,
        taskId: task.id,
        model: body.model,
      };

      const job = await queues.branching.add(QUEUE_NAMES.BRANCHING, jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });

      await prisma.task.update({
        where: { id: task.id },
        data: { bullJobId: job.id },
      });

      return {
        taskId: task.id,
        jobId: job.id,
        status: 'pending',
      };
    },
  );
}
