package id.ac.upnvj.cloudlib;

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

    public record CheckInRequest(String memberRef) {}

    private static Response error(int status, String message) {
        return Response.status(status).entity(Map.of("error", message)).build();
    }

    @GET
    public Response listAttendance(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal atau header X-Tenant belum diisi");

        List<VisitorLog> logs = VisitorLog.list("tenantId", tenant.id);
        return Response.ok(logs).build();
    }

    @POST
    @Path("/checkin")
    @Transactional
    public Response checkIn(@HeaderParam("X-Tenant") String tenantCode, CheckInRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.memberRef() == null || req.memberRef().isBlank()) {
            return error(400, "memberRef wajib diisi");
        }

        VisitorLog log = new VisitorLog();
        log.tenantId = tenant.id;
        log.memberRef = req.memberRef();
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
