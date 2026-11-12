package id.ac.upnvj.cloudlib;

import io.quarkus.hibernate.orm.panache.PanacheEntityBase;
import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "visitor_log")
public class VisitorLog extends PanacheEntityBase {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "tenant_id", nullable = false)
    public Long tenantId;

    @Column(name = "member_ref", nullable = false)
    public String memberRef;

    @Column(name = "check_in_at", nullable = false)
    public Instant checkInAt;
}
