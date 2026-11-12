package id.ac.upnvj.cloudlib;

import jakarta.persistence.LockModeType;
import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@Path("/computers")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class ComputerResource {

    public record CreateComputerRequest(String label) {}
    public record ReserveRequest(Long computerId, String memberRef, String slotStart) {}

    private static Response error(int status, String message) {
        return Response.status(status).entity(Map.of("error", message)).build();
    }

    @GET
    public Response listComputers(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal atau header X-Tenant belum diisi");

        List<Computer> computers = Computer.list("tenantId", tenant.id);
        return Response.ok(computers).build();
    }

    @POST
    @Transactional
    public Response createComputer(@HeaderParam("X-Tenant") String tenantCode, CreateComputerRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.label() == null || req.label().isBlank()) {
            return error(400, "label komputer wajib diisi");
        }

        long count = Computer.count("tenantId = ?1 and label = ?2", tenant.id, req.label());
        if (count > 0) return error(409, "label komputer sudah terdaftar pada tenant ini");

        Computer computer = new Computer();
        computer.tenantId = tenant.id;
        computer.label = req.label();
        computer.persist();

        return Response.status(201).entity(computer).build();
    }

    @GET
    @Path("/reservations")
    public Response listReservations(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");

        List<ComputerReservation> list = ComputerReservation.list("tenantId", tenant.id);
        return Response.ok(list).build();
    }

    @POST
    @Path("/reservations")
    @Transactional
    public Response reserveComputer(@HeaderParam("X-Tenant") String tenantCode, ReserveRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.computerId() == null || req.memberRef() == null || req.slotStart() == null) {
            return error(400, "computerId, memberRef, dan slotStart wajib diisi");
        }

        Computer computer = Computer.find("id = ?1 and tenantId = ?2", req.computerId(), tenant.id).firstResult();
        if (computer == null) return error(404, "komputer tidak ditemukan pada tenant ini");

        Instant slot;
        try {
            slot = Instant.parse(req.slotStart());
        } catch (Exception e) {
            return error(400, "format slotStart tidak valid, gunakan format ISO-8601 (misal: 2026-11-13T09:00:00Z)");
        }

        // Lock computer row or check existing reservation on the exact slot to prevent double-booking (QS02)
        long existing = ComputerReservation.count("computerId = ?1 and slotStart = ?2", computer.id, slot);
        if (existing > 0) {
            return error(409, "slot komputer ini sudah terisi (double booking dicegah)");
        }

        ComputerReservation res = new ComputerReservation();
        res.tenantId = tenant.id;
        res.computerId = computer.id;
        res.memberRef = req.memberRef();
        res.slotStart = slot;
        res.persist();

        return Response.status(201).entity(Map.of(
                "reservationId", res.id,
                "computerId", computer.id,
                "label", computer.label,
                "memberRef", res.memberRef,
                "slotStart", res.slotStart.toString()
        )).build();
    }
}
