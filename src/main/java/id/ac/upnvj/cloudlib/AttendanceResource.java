package id.ac.upnvj.cloudlib;

import jakarta.annotation.security.RolesAllowed;
import jakarta.inject.Inject;
import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@Path("/attendance")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class AttendanceResource {

    @Inject
    TenantIdentity tenantIdentity;

    public record CheckInRequest(String memberRef) {}

    private static Response error(int status, String message) {
        return Response.status(status).entity(Map.of("error", message)).build();
    }

    @GET
    @RolesAllowed({"petugas", "admin"})
    public Response listAttendance(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = tenantIdentity.requireTenant(tenantCode);

        List<VisitorLog> logs = VisitorLog.list("tenantId", tenant.id);
        return Response.ok(logs).build();
    }

    @POST
    @Path("/checkin")
    @RolesAllowed({"mahasiswa", "petugas"})
    @Transactional
    public Response checkIn(@HeaderParam("X-Tenant") String tenantCode, CheckInRequest req) {
        Tenant tenant = tenantIdentity.requireTenant(tenantCode);
        if (req == null) {
            return error(400, "body permintaan wajib diisi");
        }

        String memberRef = tenantIdentity.hasRole("mahasiswa")
                ? tenantIdentity.requireMemberRef()
                : req.memberRef();
        if (memberRef == null || memberRef.isBlank()) {
            return error(400, "memberRef wajib diisi untuk presensi manual");
        }

        VisitorLog log = new VisitorLog();
        log.tenantId = tenant.id;
        log.memberRef = memberRef;
        log.checkInAt = Instant.now();
        log.persist();

        return Response.status(201).entity(Map.of(
                "checkInId", log.id,
                "tenantCode", tenant.code,
                "memberRef", log.memberRef,
                "checkInAt", log.checkInAt.toString()
        )).build();
    }
}
