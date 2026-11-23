package id.ac.upnvj.cloudlib;

import io.quarkus.security.identity.SecurityIdentity;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.security.Principal;
import java.util.Map;
import org.eclipse.microprofile.jwt.JsonWebToken;

@RequestScoped
public class TenantIdentity {

    @Inject
    SecurityIdentity identity;

    public Tenant requireTenant(String requestedTenant) {
        String tenantCode = claim("tenant");
        if (tenantCode == null || tenantCode.isBlank()) {
            throw forbidden("token tidak memiliki klaim tenant");
        }
        if (requestedTenant != null && !requestedTenant.isBlank() && !requestedTenant.equals(tenantCode)) {
            throw forbidden("tenant pada header tidak sesuai dengan identitas pengguna");
        }

        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) {
            throw forbidden("tenant pada identitas pengguna tidak dikenal");
        }
        return tenant;
    }

    public String requireMemberRef() {
        String memberRef = claim("member_ref");
        if (memberRef == null || memberRef.isBlank()) {
            throw forbidden("token tidak memiliki klaim member_ref");
        }
        return memberRef;
    }

    public boolean hasRole(String role) {
        return identity.hasRole(role);
    }

    private String claim(String name) {
        Object attribute = identity.getAttribute(name);
        if (attribute != null) {
            return attribute.toString();
        }

        Principal principal = identity.getPrincipal();
        if (principal instanceof JsonWebToken token) {
            Object value = token.getClaim(name);
            return value == null ? null : value.toString();
        }
        return null;
    }

    private static WebApplicationException forbidden(String message) {
        return new WebApplicationException(Response.status(Response.Status.FORBIDDEN)
                .type(MediaType.APPLICATION_JSON_TYPE)
                .entity(Map.of("error", message))
                .build());
    }
}
