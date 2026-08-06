Act as a Senior Software Architect. We are building a B2B SaaS web application designed for medical/hospital clients that generates image masks using heavy machine learning models running on GPU workers. 

Please reference the user requirements outlined in the file "image_7f9820.png" as the foundational blueprint for our core functionality.

Implement a complete architectural design, database schema, and end-to-end data flow based on the following finalized system specifications:

### 1. High-Level Core Functionality (Asynchronous Request-Reply)
* **Frontend:** React-based single-page application.
* **Backend API:** Orchestrates business logic, authentication, and job status management.
* **Processing Pattern:** Image analysis can take several seconds to minutes. The frontend must restrict users via configuration to uploading exactly 1 image at a time.
* **Direct Storage Upload:** Frontend requests a time-limited S3 presigned URL from the API, uploads the raw image directly to Object Storage (S3), and notifies the API to queue the job.
* **Processing Workers:** Isolated GPU-bound container instances processing jobs asynchronously via a message queue (e.g., AWS SQS or RabbitMQ). 
* **Real-Time Notification:** Once the GPU worker finishes, saves the mask to S3, and updates the database, the backend triggers a real-time notification to the React frontend using Server-Sent Events (SSE) or WebSockets to display the finished mask.
* **Data Retention:** Storage cleanup/wiping must be fully configurable (e.g., automated S3 lifecycle rules to delete files after X days).

### 2. Multi-Tenant B2B Structure (Organization -> Users)
* **Hierarchy:** An `Organization` owns a shared master pool of credits. Multiple `Users` belong to an Organization.
* **Roles:** 
  * `ORG_ADMIN`: Can manage team members, view billing, and generate invite links.
  * `MEMBER`: Can upload images and view processing logs, but cannot access admin controls.
* **Data Isolation:** Design strict multi-tenant isolation. S3 paths must be segregated by organization UUID (`s3://bucket/org_id=<uuid>/...`). Database schema should be ready for Row-Level Security (RLS) based on `organization_id`.

### 3. Open Registration & Reusable Invite System
* **First-In Creator:** The first person to sign up via email creates a brand new `Organization` and is automatically granted the `ORG_ADMIN` role. 
* **Trial Credits:** Upon organization creation, the workspace is seeded with exactly 3 trial credits.
* **Reusable Invite Links:** Admins can generate a single reusable link (`/join/inv_<uuid>`) to copy-paste into internal communications to invite colleagues.
* **Hospital-Grade Security:** The invite config table must support an `allowed_domains` array (e.g., `['stjude.org']`). The backend must validate and enforce that an registering user's email domain matches the whitelist before granting access to the organization. Links must feature a manually toggleable `is_active` status (a panic/revoke button).

### 4. Bulletproof Credit Consumption Logic
* **Deduction Rule:** Credits are deducted ONLY upon successful completion of an image processing job.
* **Concurrency Protection:** To prevent race conditions where multiple users in the same organization exhaust a single remaining credit simultaneously, the backend must use row-level locking (`SELECT FOR UPDATE` within a strict database transaction) when updating the organization's credit balance. 
* **Atomic States:** If a job fails or times out, the credit must not be consumed, and the job status transitions to `FAILED`.

---

Based on these architectural requirements, please generate:
1. A clean, production-ready relational database schema SQL definition (PostgreSQL syntax) reflecting the tables for Organizations, Users, Jobs, and Organization_Invites.
2. A detailed architectural block diagram text layout mapping the components from Frontend to GPU Workers.
3. The core backend pseudocode/logic for the atomic Credit Deduction Transaction when a job completes successfully.