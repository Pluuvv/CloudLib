package id.ac.upnvj.cloudlib;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.Map;

@Path("/dashboard")
@Produces(MediaType.APPLICATION_JSON)
public class DashboardResource {

    @GET
    @Path("/summary")
    public Response getSummary(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) {
            return Response.status(400).entity(Map.of("error", "tenant tidak dikenal atau header X-Tenant belum diisi")).build();
        }

        long totalBooks = Book.count("tenantId", tenant.id);
        long totalCopies = BookCopy.count("tenantId", tenant.id);
        long availableCopies = BookCopy.count("tenantId = ?1 and status = 'AVAILABLE'", tenant.id);
        long activeLoans = Loan.count("tenantId = ?1 and returnedAt is null", tenant.id);
        long totalReservations = ComputerReservation.count("tenantId", tenant.id);
        long totalVisitors = VisitorLog.count("tenantId", tenant.id);

        return Response.ok(Map.of(
                "tenantCode", tenant.code,
                "tenantName", tenant.name,
                "totalBooks", totalBooks,
                "totalCopies", totalCopies,
                "availableCopies", availableCopies,
                "activeLoans", activeLoans,
                "totalReservations", totalReservations,
                "totalVisitors", totalVisitors
        )).build();
    }
}
