package id.ac.upnvj.cloudlib;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import java.util.List;

@Path("/tenants")
@Produces(MediaType.APPLICATION_JSON)
public class TenantResource {
    @GET
    public List<Tenant> list() {
        return Tenant.listAll();
    }
}
