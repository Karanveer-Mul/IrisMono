# Architectural Design & Specification
**B2B SaaS Medical Image Mask Generation Platform**

This document details the database design, end-to-end architecture, and credit consumption logic for the multi-tenant medical image masking platform, incorporating the design decisions made regarding credit reservation, infrastructure segregation, whitelisting behavior, and audit logs.

---

## 1. Relational Database Schema (PostgreSQL)

This schema uses PostgreSQL-compatible syntax. It includes indices for rapid lookups and sets up the base elements for PostgreSQL **Row-Level Security (RLS)**.

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Define custom types/enums
CREATE TYPE user_role AS ENUM ('ORG_ADMIN', 'MEMBER');
CREATE TYPE job_status AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- 1. Organizations Table
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    -- Available credits that can be used to queue new jobs
    credit_balance INT NOT NULL DEFAULT 3 CONSTRAINT positive_credit_balance CHECK (credit_balance >= 0),
    -- Whitelisted email domains (e.g. ['stjude.org', '*.stjude.org'])
    allowed_domains TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'MEMBER',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Organization Invites Table
CREATE TABLE organization_invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invite_code VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'inv_uuid'
    -- Whitelist array copied/customized for this specific invite link
    allowed_domains TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE
);

-- 4. Jobs Table (Metadata maintained indefinitely for auditing/billing)
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status job_status NOT NULL DEFAULT 'PENDING',
    raw_image_s3_key VARCHAR(512) NOT NULL, -- Path format: s3://bucket/org_id=<org_uuid>/jobs/<job_uuid>/raw.png
    mask_image_s3_key VARCHAR(512),         -- Path format: s3://bucket/org_id=<org_uuid>/jobs/<job_uuid>/mask.png
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

---
--- Indices for Optimization & Foreign Keys
---
CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_invites_code ON organization_invites(invite_code);
CREATE INDEX idx_jobs_org ON jobs(organization_id);
CREATE INDEX idx_jobs_user ON jobs(user_id);
CREATE INDEX idx_jobs_status ON jobs(status);

---
--- Row-Level Security (RLS) Setup
---
-- Turn on RLS for tenant-isolated tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

-- Example of dynamic execution context policy
-- These policies assume a session variable `app.current_organization_id` is set by the backend API connection pool on request lifecycle.
CREATE POLICY tenant_isolation_users ON users
    FOR ALL
    USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY tenant_isolation_jobs ON jobs
    FOR ALL
    USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY tenant_isolation_invites ON organization_invites
    FOR ALL
    USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);
```

---

## 2. End-to-End Architectural Block Diagram

This layout highlights the data flow, the direct S3 uploads, the message routing queues, and the Server-Sent Events (SSE) notification cycle.

```
       +--------------------------------------------------------+
       |                  React SPA Frontend                    |
       +-------+--------------------+-------------------+--------+
               |                    |                   ^
      (1) Get  |                    | (3) Upload        | (8) SSE
      Presigned|                    | Raw Image         | Live Mask
        URL    v                    v                   | Notification
       +-------+------+       +-----+------+            |
       |  Backend API |       |  Object    |            |
       |  Web Service |       |  Storage   |            |
       +-------+------+       |  (S3)      |            |
               |              +-----+------+            |
      (2) Reserve Credit &          ^                   |
          Queue Job                 |                   |
               v                    |                   |
       +-------+------+             |                   |
       | Message      |             |                   |
       | Broker       |             |                   |
       | (SQS/Rabbit) |             |                   |
       +-------+------+             |                   |
               |                    | (5) Read Raw Image|
               | (4) Dispatch       |     & Write Mask  |
               v                    v                   |
       +-------+--------------------+-------------------+--------+
       |              GPU Workers Container Pool                |
       |                                                        |
       |  +--------------------+        +--------------------+  |
       |  | Standard Queue     |        | VIP/Large Tenant   |  |
       |  | Consumers          |        | Dedicated Workers  |  |
       |  +--------------------+        +--------------------+  |
       +----------------------------+---------------------------+
                                    |
                                    | (6) Job Completion/Failure Call
                                    v
                             +------+------+
                             | SSE Hub /   |-------(7) Trigger SSE Event
                             | Backend API |
                             +-------------+
```

### Data Flow Execution Steps:
1. **Pre-upload Authorization:** The React SPA requests a time-limited S3 presigned URL from the **Backend API**.
2. **Atomic Queuing & Credit Reservation:** The Backend locks the organization's credit balance using a transaction. If a credit is available, it decrements the available balance (acting as a **Reservation** / Option A) and queues the job ID. It returns the S3 presigned URL to the Frontend.
3. **Direct-to-S3 Upload:** The React SPA bypasses the Backend API completely to upload the heavy raw image directly to the isolated path in S3 (`s3://bucket/org_id=<org_uuid>/jobs/<job_uuid>/raw.png`).
4. **Execution Dispatch:** Once uploaded, the Frontend notifies the Backend to change the job status to `PENDING` and publish a message containing the S3 path and Job UUID to the **Message Broker**.
   - Standard organization workloads go to a shared queue.
   - Large or enterprise-level organizations route to a **dedicated VIP queue** mapped to dedicated GPU workers for infrastructure isolation.
5. **GPU Processing:** An idle GPU worker pulls the message from the queue, pulls the raw image from S3, processes the ML mask model, uploads the resulting mask back to S3 under `s3://bucket/org_id=<org_uuid>/jobs/<job_uuid>/mask.png`, and reports success (or failure) to the Backend API.
6. **Result Finalization & Notifications:** The Backend updates the SQL job record status. 
   - **On Success:** The job transitions to `SUCCESS`. (The credit decrement performed during queue-time is finalized).
   - **On Failure:** The job transitions to `FAILED`, and the credit is **refunded** back to the organization's database balance.
7. **Real-time Push:** The Backend triggers an SSE connection event, prompting the Frontend to render the newly generated mask image from its S3 path.

---

## 3. Atomic Credit Reservation & Transaction Logic

This section outlines the pseudocode execution blocks for reserving credit balance at queue-time and resolving/refunding it on job outcome.

### 3.1. Job Creation and Credit Reservation (Queue-time)

```typescript
async function queueJob(userId: string, orgId: string, rawImageS3Key: string): Promise<string> {
    // Start Transaction
    const tx = await db.beginTransaction();
    
    try {
        // 1. Lock the organization's balance row to avoid race conditions
        const org = await tx.query(
            `SELECT credit_balance 
             FROM organizations 
             WHERE id = $1 
             FOR UPDATE`, 
            [orgId]
        );
        
        if (!org || org.credit_balance <= 0) {
            throw new Error("Insufficient credits remaining to run job.");
        }
        
        // 2. Reserve the credit by decrementing the available balance
        await tx.query(
            `UPDATE organizations 
             SET credit_balance = credit_balance - 1, 
                 updated_at = NOW() 
             WHERE id = $1`, 
            [orgId]
        );
        
        // 3. Create the job record in database
        const job = await tx.query(
            `INSERT INTO jobs (organization_id, user_id, status, raw_image_s3_key) 
             VALUES ($1, $2, 'PENDING', $3) 
             RETURNING id`, 
            [orgId, userId, rawImageS3Key]
        );
        
        // Commit transaction
        await tx.commit();
        
        // 4. Publish message to appropriate Message Queue (outside the DB transaction block)
        const isVip = await checkOrgInfrastructureTier(orgId);
        const queueName = isVip ? `queue-vip-${orgId}` : 'queue-standard-jobs';
        await messageQueue.publish(queueName, { jobId: job.id, orgId: orgId, s3Key: rawImageS3Key });
        
        return job.id;
        
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}
```

### 3.2. Job Finalization (Completion Worker Callback)

```typescript
async function finalizeJob(jobId: string, status: 'SUCCESS' | 'FAILED', errorMessage: string | null = null) {
    // Start Transaction
    const tx = await db.beginTransaction();
    
    try {
        // Lock the job record for update
        const job = await tx.query(
            `SELECT id, organization_id, status 
             FROM jobs 
             WHERE id = $1 
             FOR UPDATE`, 
            [jobId]
        );
        
        if (!job) {
            throw new Error("Job not found.");
        }
        
        if (job.status !== 'PENDING' && job.status !== 'PROCESSING') {
            throw new Error("Job has already been finalized.");
        }
        
        if (status === 'SUCCESS') {
            // Success: Update state. Credit remains consumed.
            await tx.query(
                `UPDATE jobs 
                 SET status = 'SUCCESS', 
                     completed_at = NOW() 
                 WHERE id = $1`, 
                [jobId]
            );
        } else {
            // Failure: Transition status and refund credit
            await tx.query(
                `UPDATE jobs 
                 SET status = 'FAILED', 
                     error_message = $2, 
                     completed_at = NOW() 
                 WHERE id = $1`, 
                [jobId, errorMessage]
            );
            
            // Lock organization table and refund credit
            await tx.query(
                `UPDATE organizations 
                 SET credit_balance = credit_balance + 1, 
                     updated_at = NOW() 
                 WHERE id = $1`, 
                [job.organization_id]
            );
        }
        
        await tx.commit();
        
        // Trigger real-time client notification via Server-Sent Events (SSE)
        sseHub.sendNotificationToOrg(job.organization_id, {
            type: "JOB_STATUS_CHANGE",
            jobId: jobId,
            status: status,
            error: errorMessage
        });
        
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}
```
