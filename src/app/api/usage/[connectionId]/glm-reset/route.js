// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { isGlmZcodeEligible } from "@/shared/services/glmZcodeMaintenance";
import { useGlmResetProtected } from "@/shared/services/glmZcodeReset";
import { refreshAndUpdateCredentials } from "../route.js";

// Consume one GLM Zcode reset opportunity (irreversible; write-ahead protected)
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const { resetType } = await request.json().catch(() => ({}));

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (!isGlmZcodeEligible(connection)) {
      return Response.json({ error: "Reset use is only available for GLM Zcode OAuth connections." }, { status: 400 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const result = await useGlmResetProtected(connection, resetType, proxyOptions);

    if (result.ok) return Response.json(result);
    const status = result.status >= 400 && result.status < 500 ? result.status : 409;
    return Response.json({ error: "Reset not applied", message: result.message, uncertain: result.uncertain === true }, { status });
  } catch (error) {
    console.warn(`[GLM Reset] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
