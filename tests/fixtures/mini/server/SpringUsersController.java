package demo.api;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/spring")
public class SpringUsersController {
    @GetMapping("/ping")
    public String ping() {
        return "pong";
    }

    @PostMapping("/save")
    public void save() {}
}
