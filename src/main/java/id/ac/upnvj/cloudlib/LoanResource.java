package id.ac.upnvj.cloudlib;

import jakarta.persistence.LockModeType;
import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@Path("/loans")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class LoanResource {

    public record BorrowRequest(String barcode, String memberRef) {}
    public record ReturnRequest(String barcode) {}

    private static Response error(int status, String message) {
        return Response.status(status).entity(Map.of("error", message)).build();
    }

    @GET
    @Path("/active")
    public Response listActiveLoans(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal atau header X-Tenant belum diisi");

        List<Loan> activeLoans = Loan.list("tenantId = ?1 and returnedAt is null", tenant.id);
        return Response.ok(activeLoans).build();
    }

    @GET
    @Path("/history")
    public Response listLoanHistory(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");

        List<Loan> allLoans = Loan.list("tenantId", tenant.id);
        return Response.ok(allLoans).build();
    }

    @POST
    @Transactional
    public Response borrow(@HeaderParam("X-Tenant") String tenantCode, BorrowRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.barcode() == null || req.memberRef() == null || req.barcode().isBlank()) {
            return error(400, "barcode dan memberRef wajib diisi");
        }

        // Pessimistic write lock to prevent race conditions during concurrent borrowing
        BookCopy copy = BookCopy.find("tenantId = ?1 and barcode = ?2", tenant.id, req.barcode())
                .withLock(LockModeType.PESSIMISTIC_WRITE).firstResult();
        if (copy == null) return error(404, "eksemplar tidak ditemukan pada tenant ini");
        if (!"AVAILABLE".equals(copy.status)) return error(409, "eksemplar sedang tidak tersedia atau sedang dipinjam");

        // Verify there is no active unreturned loan for this copy
        long activeLoanCount = Loan.count("bookCopyId = ?1 and returnedAt is null", copy.id);
        if (activeLoanCount > 0) {
            return error(409, "eksemplar ini memiliki transaksi peminjaman aktif yang belum dikembalikan");
        }

        Loan loan = new Loan();
        loan.tenantId = tenant.id;
        loan.bookCopyId = copy.id;
        loan.memberRef = req.memberRef();
        loan.borrowedAt = Instant.now();
        loan.dueAt = loan.borrowedAt.plus(Duration.ofDays(14));
        loan.persist();

        copy.status = "UNAVAILABLE";

        return Response.status(201).entity(Map.of(
                "loanId", loan.id,
                "tenantId", tenant.id,
                "barcode", copy.barcode,
                "memberRef", loan.memberRef,
                "borrowedAt", loan.borrowedAt.toString(),
                "dueAt", loan.dueAt.toString()
        )).build();
    }

    @POST
    @Path("/return")
    @Transactional
    public Response giveBack(@HeaderParam("X-Tenant") String tenantCode, ReturnRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.barcode() == null || req.barcode().isBlank()) {
            return error(400, "barcode wajib diisi");
        }

        BookCopy copy = BookCopy.find("tenantId = ?1 and barcode = ?2", tenant.id, req.barcode())
                .withLock(LockModeType.PESSIMISTIC_WRITE).firstResult();
        if (copy == null) return error(404, "eksemplar tidak ditemukan pada tenant ini");

        Loan loan = Loan.find("bookCopyId = ?1 and returnedAt is null", copy.id).firstResult();
        if (loan == null) return error(409, "eksemplar tidak sedang dipinjam");

        loan.returnedAt = Instant.now();
        copy.status = "AVAILABLE";

        return Response.ok(Map.of(
                "loanId", loan.id,
                "barcode", copy.barcode,
                "status", "AVAILABLE",
                "returnedAt", loan.returnedAt.toString()
        )).build();
    }
}
