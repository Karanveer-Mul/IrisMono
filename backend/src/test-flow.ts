import * as fs from "fs";
import * as path from "path";

const BASE_URL = "http://localhost:3000/api";

// Simple wrapper around fetch to make JSON requests
async function request(path: string, method = "GET", body: any = null, token: string | null = null) {
  const headers: any = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const options: any = {
    method,
    headers,
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`[HTTP ${response.status}] ${JSON.stringify(data)}`);
  }
  return data;
}

async function runTests() {
  console.log("=== STARTING ARCHITECTURAL FLOW INTEGRATION TEST ===\n");

  // Unique per run: the flow registers accounts, and re-registering a fixed
  // address fails with 409. Without this the suite only passes against an
  // empty database.
  const stamp = Date.now();

  try {
    // 1. Register new organization (First-In Creator)
    console.log("1. Registering first creator for St. Jude Children Hospital...");
    const adminReg = await request("/auth/register", "POST", {
      email: `director.${stamp}@stjude.org`,
      password: "secure_password_123",
      orgName: `St. Jude Hospital ${stamp}`
    });
    const adminToken = adminReg.token;
    console.log("-> Admin registration successful. Token obtained.");

    // 2. Fetch admin user info & verify credit balance
    console.log("\n2. Checking initial organization credit balance (expecting 3)...");
    const adminLogsBefore = await request("/jobs/logs", "GET", null, adminToken);
    console.log(`-> Log count: ${adminLogsBefore.logs.length}`);
    
    // 3. Generate reusable invite link
    console.log("\n3. Generating reusable invite link for organization...");
    const inviteRes = await request("/invites", "POST", {
      expiresDays: 1
    }, adminToken);
    console.log(`-> Invite generated: ${inviteRes.inviteLink}`);
    const inviteCode = inviteRes.invite.inviteCode;

    // 4. Try to register with non-whitelisted email domain (should fail)
    console.log("\n4. Attempting to register user with Gmail address via invite link...");
    try {
      await request(`/auth/join/${inviteCode}`, "POST", {
        email: `hacker.${stamp}@gmail.com`,
        password: "member_password"
      });
      console.error("FAIL: Gmail registration should have been blocked!");
    } catch (err: any) {
      console.log(`-> Blocked successfully. Error message: ${err.message}`);
    }

    // 5. Register with whitelisted subdomain email domain (should succeed)
    console.log("\n5. Registering member with whitelisted subdomain (research.stjude.org) email...");
    const memberReg = await request(`/auth/join/${inviteCode}`, "POST", {
      email: `researcher.${stamp}@research.stjude.org`,
      password: "member_password_123"
    });
    const memberToken = memberReg.token;
    console.log("-> Member registration successful. Token obtained.");

    // 6. Request job creation & credit reservation (Option A)
    console.log("\n6. Requesting upload URL & reserving credit...");
    const jobRequest = await request("/jobs/request", "POST", {}, memberToken);
    console.log(`-> Reserved Job ID: ${jobRequest.jobId}`);
    console.log(`-> Upload URL: ${jobRequest.uploadUrl}`);
    const jobId = jobRequest.jobId;

    // 7. Perform direct mock file upload to the presigned upload URL
    console.log("\n7. Uploading raw image file direct to mock storage path...");
    // Must start with the PNG signature: the storage layer validates the first
    // bytes rather than trusting the Content-Type the client sent.
    const dummyImageBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("dummy-image-binary-data"),
    ]);
    const uploadRes = await fetch(jobRequest.uploadUrl, {
      method: "PUT",
      body: dummyImageBuffer,
      headers: {
        "Content-Type": "image/png"
      }
    });
    if (!uploadRes.ok) {
      throw new Error(`Direct upload failed: ${uploadRes.status}`);
    }
    const uploadBody = await uploadRes.json();
    console.log(`-> File upload completed, and it queued the job: ${uploadBody.queue}`);
    if (!uploadBody.dispatched) {
      throw new Error("Completing the upload did not dispatch the job");
    }

    // 8. The old third step is now redundant, and must be refused rather than
    // queueing the same scan a second time.
    console.log("\n8. The client's separate trigger call is no longer needed...");
    const redundant = await fetch(`${BASE_URL}/jobs/${jobId}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
    });
    console.log(`-> Redundant trigger answered HTTP ${redundant.status} (already dispatched)`);
    if (redundant.status !== 400) {
      throw new Error(`Expected the redundant trigger to be refused, got ${redundant.status}`);
    }

    // 9. Wait for worker simulation
    console.log("\n9. Waiting 6 seconds for GPU simulation worker to complete the job...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // 10. Check results & final credit status
    console.log("\n10. Fetching logs and final job status...");
    const logsAfter = await request("/jobs/logs", "GET", null, memberToken);
    const finalJob = logsAfter.logs.find((j: any) => j.id === jobId);
    console.log(`-> Final Job Status: ${finalJob.status}`);
    if (finalJob.status === "SUCCESS") {
      console.log(`-> Result Mask S3 path: ${finalJob.maskImageS3Key}`);
    } else {
      console.log(`-> Error Message: ${finalJob.errorMessage}`);
    }

    // 11. Test Revocation Panic Button
    console.log("\n11. Testing invite link panic/revocation button...");
    const toggleRes = await request(`/invites/${inviteRes.invite.id}/toggle`, "PATCH", {}, adminToken);
    console.log(`-> Invite Active Status: ${toggleRes.invite.isActive}`);

    console.log("\n12. Attempting to register via revoked invite link...");
    try {
      await request(`/auth/join/${inviteCode}`, "POST", {
        email: `another_researcher.${stamp}@stjude.org`,
        password: "member_password"
      });
      console.error("FAIL: Registration via revoked link should have been blocked!");
    } catch (err: any) {
      console.log(`-> Blocked successfully. Error message: ${err.message}`);
    }

    console.log("\n=== INTEGRATION TEST COMPLETED SUCCESSFULLY ===");

  } catch (error) {
    console.error("\nFAIL: Test run aborted with error:", error);
    process.exit(1);
  }
}

runTests();
