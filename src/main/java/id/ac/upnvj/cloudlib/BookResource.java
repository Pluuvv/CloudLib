package id.ac.upnvj.cloudlib;

import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;
import java.util.Map;

@Path("/books")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class BookResource {

    public record CreateBookRequest(String title, String author, String isbn) {}
    public record CreateCopyRequest(Long bookId, String barcode) {}

    private static Response error(int status, String message) {
        return Response.status(status).entity(Map.of("error", message)).build();
    }

    @GET
    public Response listBooks(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal atau header X-Tenant belum diisi");

        List<Book> books = Book.list("tenantId", tenant.id);
        return Response.ok(books).build();
    }

    @POST
    @Transactional
    public Response createBook(@HeaderParam("X-Tenant") String tenantCode, CreateBookRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.title() == null || req.title().isBlank()) {
            return error(400, "judul buku wajib diisi");
        }

        Book book = new Book();
        book.tenantId = tenant.id;
        book.title = req.title();
        book.author = req.author();
        book.isbn = req.isbn();
        book.persist();

        return Response.status(201).entity(book).build();
    }

    @GET
    @Path("/copies")
    public Response listCopies(@HeaderParam("X-Tenant") String tenantCode) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");

        List<BookCopy> copies = BookCopy.list("tenantId", tenant.id);
        return Response.ok(copies).build();
    }

    @POST
    @Path("/copies")
    @Transactional
    public Response createCopy(@HeaderParam("X-Tenant") String tenantCode, CreateCopyRequest req) {
        Tenant tenant = Tenant.find("code", tenantCode).firstResult();
        if (tenant == null) return error(400, "tenant tidak dikenal");
        if (req == null || req.bookId() == null || req.barcode() == null || req.barcode().isBlank()) {
            return error(400, "bookId dan barcode wajib diisi");
        }

        Book book = Book.find("id = ?1 and tenantId = ?2", req.bookId(), tenant.id).firstResult();
        if (book == null) return error(404, "buku tidak ditemukan pada tenant ini");

        long count = BookCopy.count("tenantId = ?1 and barcode = ?2", tenant.id, req.barcode());
        if (count > 0) return error(409, "barcode sudah terdaftar pada tenant ini");

        BookCopy copy = new BookCopy();
        copy.tenantId = tenant.id;
        copy.bookId = book.id;
        copy.barcode = req.barcode();
        copy.status = "AVAILABLE";
        copy.persist();

        return Response.status(201).entity(copy).build();
    }
}
