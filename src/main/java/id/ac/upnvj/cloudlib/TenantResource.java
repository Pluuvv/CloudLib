package id.ac.upnvj.cloudlib;

import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;
import java.util.Map;

@Path("/tenants")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class TenantResource {

    public record CreateTenantRequest(String code, String name) {}

    @GET
    public List<Tenant> list() {
        return Tenant.listAll();
    }

    @POST
    @Transactional
    public Response create(CreateTenantRequest req) {
        if (req == null || req.code() == null || req.name() == null || req.code().isBlank()) {
            return Response.status(400).entity(Map.of("error", "code dan name wajib diisi")).build();
        }

        long count = Tenant.count("code", req.code().trim().toLowerCase());
        if (count > 0) {
            return Response.status(409).entity(Map.of("error", "kode tenant sudah terdaftar")).build();
        }

        Tenant tenant = new Tenant();
        tenant.code = req.code().trim().toLowerCase();
        tenant.name = req.name().trim();
        tenant.persist();

        return Response.status(201).entity(tenant).build();
    }
}
